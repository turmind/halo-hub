import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { BrowserContext } from 'playwright'
import { BROWSER_VIEWPORT, type BrowserRuntimeInfo } from './protocol.js'
import { BrowserFault, BrowserLaunchFault, checkSignal } from './errors.js'
import { privateDirectory } from './profile-store.js'
import { trackBrowser, trackChildProcess } from './lifecycle.js'

export type BrowserLauncher = (profile: string, signal: AbortSignal, progress: (runtime: BrowserRuntimeInfo) => void) => Promise<BrowserContext>
const require = createRequire(resolve(process.argv[1] ?? join(process.cwd(), 'package.json')))
const exists = async (path: string) => access(path).then(() => true, () => false)

export function createBrowserLauncher(dataDir: string): BrowserLauncher {
  let install: Promise<string> | undefined
  async function pinned(signal: AbortSignal): Promise<string> {
    if (!install) install = (async () => {
      const directory = join(dataDir, 'browsers')
      await privateDirectory(directory)
      const packageDir = join(require.resolve('playwright-core/package.json'), '..')
      const registry = JSON.parse(await readFile(join(packageDir, 'browsers.json'), 'utf8')) as { browsers: Array<{ name: string; revision: string }> }
      const revision = registry.browsers.find(browser => browser.name === 'chromium')!.revision
      const executable = process.platform === 'win32' ? 'chrome-win64/chrome.exe' : process.platform === 'darwin' ? 'chrome-mac-' + (process.arch === 'arm64' ? 'arm64' : 'x64') + '/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' : process.arch === 'arm64' ? 'chrome-linux/chrome' : 'chrome-linux64/chrome'
      const target = join(directory, `chromium-${revision}`, executable)
      const marker = join(directory, `chromium-${revision}`, 'INSTALLATION_COMPLETE')
      if (!await exists(target) || !await exists(marker)) {
        await new Promise<void>((resolve, reject) => {
          // Playwright owns download locking/atomic completion; inherited HTTP(S)_PROXY
          // is consumed by its installer. Never forward installer output to agents.
          const child = spawn(process.execPath, [join(require.resolve('playwright/package.json'), '..', 'cli.js'), 'install', 'chromium', '--no-shell'], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: directory }, stdio: 'ignore', detached: process.platform !== 'win32', signal, timeout: 10 * 60 * 1000 })
          const untrack = child.pid ? trackChildProcess(child.pid) : () => {}
          child.on('error', () => reject(new BrowserFault('unavailable')))
          child.on('exit', code => { untrack(); if (code === 0) resolve(); else reject(new BrowserFault('unavailable')) })
        })
      }
      if (!await exists(target) || !await exists(marker)) throw new BrowserFault('unavailable')
      return target
    })().catch(error => { install = undefined; throw error })
    return install
  }
  return async (profile, signal, progress) => {
    const { chromium } = await import('playwright')
    const candidates: string[] = []
    if (process.platform === 'darwin') {
      for (const app of ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge']) {
        for (const root of ['/Applications', join(homedir(), 'Applications')]) if (await exists(join(root, app))) candidates.push(join(root, app))
      }
    } else if (process.platform === 'win32') {
      for (const [exe, app] of [['chrome.exe', 'Google/Chrome/Application/chrome.exe'], ['msedge.exe', 'Microsoft/Edge/Application/msedge.exe']]) {
        for (const hive of ['HKCU', 'HKLM']) {
          try {
            const { stdout } = await promisify(execFile)('reg.exe', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'], { timeout: 3000 })
            const registered = stdout.match(/REG_SZ\s+(.+)/)?.[1]?.trim().replace(/^"|"$/g, '')
            if (registered && await exists(registered)) candidates.push(registered)
          } catch { /* Missing stable App Paths entry; check standard install roots next. */ }
        }
        for (const root of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) if (root && await exists(join(root, app))) candidates.push(join(root, app))
      }
    }
    const launch = async (executablePath: string) => {
      checkSignal(signal)
      let env: NodeJS.ProcessEnv | undefined
      if (process.platform === 'linux') {
        const root = join(dataDir, 'chromium-xdg')
        const paths = { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data') }
        await Promise.all(Object.values(paths).map(privateDirectory))
        // Crashpad uses XDG config; NSS prefers an existing HOME/.pki over XDG data. Isolate the browser child only.
        env = { ...process.env, ...paths }
      }
      const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: BROWSER_VIEWPORT, timeout: 30000, acceptDownloads: false, args: ['--no-first-run', '--no-default-browser-check'], ...(env ? { env } : {}) })
      try { checkSignal(signal); await trackBrowser(context); return context }
      catch (error) { await context.close(); throw error }
    }
    for (const candidate of candidates) { try { return await launch(candidate) } catch { checkSignal(signal) } }
    progress({ protocol: 1, status: 'downloading' })
    const executable = await pinned(signal)
    progress({ protocol: 1, status: 'starting' })
    try { return await launch(executable) }
    catch (error) {
      const failure = new BrowserLaunchFault(error)
      console.error(`[Browser] ${failure.message}`)
      throw failure
    }
  }
}
