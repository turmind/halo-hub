import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext, CDPSession } from 'playwright'
import { safeUrl } from './errors.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
let windowsSid: Promise<string> | undefined

declare const send: CDPSession['send']
type CookieParams = NonNullable<Parameters<typeof send<'Network.setCookies'>>[1]>['cookies']

export async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(directory, 0o700)
  else {
    // Dedicated extension state only. No source browser/profile ACL is modified.
    windowsSid ??= exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { timeout: 5000 }).then(({ stdout }) => {
      const sid = stdout.match(/S-1-5-[0-9-]+/)?.[0]
      if (!sid) throw new Error('Current-user ACL identity unavailable')
      return sid
    })
    const sid = await windowsSid
    await exec('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { timeout: 5000 })
  }
}
export class ProfileStore {
  readonly directory: string
  readonly profile: string
  private prior = new Map<string, string>()
  private writes = Promise.resolve()
  constructor(dataDir: string, projectId: string) {
    this.directory = join(dataDir, 'workspaces', createHash('sha256').update(projectId).digest('hex'))
    this.profile = join(this.directory, 'profile')
  }
  async init() {
    await privateDirectory(join(this.directory, '..'))
    await privateDirectory(this.directory)
    await privateDirectory(this.profile)
    this.prior.clear()
    // Artifacts are ephemeral, never recover authority from a previous process.
    await rm(join(this.directory, 'artifacts'), { recursive: true, force: true })
    await privateDirectory(join(this.directory, 'artifacts'))
  }
  async read(name: string): Promise<string | undefined> {
    try { return await readFile(join(this.directory, name), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  async save(name: string, value: unknown): Promise<boolean> {
    const serialized = JSON.stringify(value)
    let changed = false
    const task = this.writes.then(async () => {
      const before = this.prior.get(name) ?? await this.read(name)
      if (before === serialized) { this.prior.set(name, serialized); return }
      const target = join(this.directory, name)
      const temp = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, serialized, { mode: 0o600 })
        await rename(temp, target)
        this.prior.set(name, serialized); changed = true
      } finally { await rm(temp, { force: true }) }
    })
    this.writes = task.catch(() => {})
    await task
    return changed
  }
  async checkpoint(context: BrowserContext) {
    const page = context.pages()[0] ?? await context.newPage()
    const cdp = await context.newCDPSession(page)
    try {
      const { cookies } = await cdp.send('Storage.getCookies')
      const sessions = cookies.filter(cookie => cookie.session).map(cookie => {
        if (cookie.partitionKeyOpaque) throw new Error('Unrepresentable session partition')
        const result: CookieParams[number] = {
          name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
          secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
          priority: cookie.priority, sourceScheme: cookie.sourceScheme, sourcePort: cookie.sourcePort,
          ...(cookie.partitionKey ? { partitionKey: { topLevelSite: cookie.partitionKey.topLevelSite, hasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor } } : {}),
        }
        return result
      }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      await this.save('session-cookies.json', sessions)
    } finally { await cdp.detach() }
  }
  async restore(context: BrowserContext) {
    await this.writes
    const serialized = await this.read('session-cookies.json')
    if (!serialized) return
    const cookies: CookieParams = JSON.parse(serialized)
    const cdp = await context.newCDPSession(context.pages()[0] ?? await context.newPage())
    try { if (cookies.length) await cdp.send('Network.setCookies', { cookies }) }
    finally { await cdp.detach() }
  }
  async tabs(): Promise<{ urls: string[]; selected: number }> {
    const data = await this.read('tabs.json')
    if (!data) return { urls: [], selected: 0 }
    const parsed = JSON.parse(data) as { tabs: Array<{ url: string }>; selected: number }
    return { urls: parsed.tabs.map(tab => safeUrl(tab.url)).filter(url => /^https?:/.test(url)).slice(0, 32), selected: parsed.selected }
  }
}
