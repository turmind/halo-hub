import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { appBound, currentMachine, discover, jsonFile } from './discovery.js'
import { metadata, decodeStore, validateEnvelopes } from './cookies.js'
import { readStore, fileFingerprint, type StoreRead } from './store-reader.js'
import { siteScope, type SiteScope } from './site-scope.js'
import { safariMetadata } from './safari.js'
import { OsSecrets, runTool, type ToolRunner } from './os-secrets.js'
import { installCookies } from './import-cookies.js'
import { check, publicReason, reasons, SigninFault, type Machine, type Source, type SigninHost, type SigninService, type SigninSource, type SigninImportResult } from './types.js'

interface Candidate { source: Source; dto: SigninSource; store?: StoreRead }
async function inspect(source: Source, scope: SiteScope, signal: AbortSignal): Promise<Candidate> {
  const dto: SigninSource = { id: source.id, browser: source.browser, profile: source.profile, count: null, newestExpiry: null, available: false, reason: '' }
  try {
    if (source.unavailable) throw new SigninFault(source.unavailable)
    if (source.family === 'safari') { Object.assign(dto, await safariMetadata(source, scope)); throw new SigninFault('format') }
    const store = await readStore(source, scope, false, signal)
    dto.count = store.rows.length
    const expiries = store.rows.filter(r => r.persistent).map(r => source.family === 'chromium' ? Number(r.expiry / 1000000n - 11644473600n) : Number(r.expiry))
    dto.newestExpiry = expiries.length ? new Date(Math.max(...expiries) * 1000).toISOString() : null
    for (const row of store.rows) metadata(row, source, scope)
    dto.available = true; dto.reason = 'Readable metadata only; permission and storage-key checks occur after approval. Import does not prove the site will accept the sign-in.'
    return { source, dto, store }
  } catch (error) { dto.reason = publicReason(error); return { source, dto } }
}
/** The optional factory builder is internal dependency injection for manufactured fixtures,
 * never an agent/API-supplied profile path or machine selector. Production uses OS defaults. */
export function signinFactory(machine: Machine, run: ToolRunner = runTool): (host: SigninHost) => SigninService {
  return host => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    host.signal.addEventListener('abort', abort, { once: true })
    if (host.signal.aborted) abort()
    const signal = controller.signal
    const secrets = new OsSecrets(machine, signal, run)
    const pending = new Map<string, Promise<SigninImportResult>>()
    const candidates = async (scope: SiteScope) => {
      check(signal)
      const all = await discover(machine)
      const result: Candidate[] = []
      // One bounded SQLite worker at a time; all OS prompts are batched separately after consent.
      for (const source of all) { check(signal); const item = await inspect(source, scope, signal); if (item.dto.count !== 0) result.push(item) }
      return { all, result }
    }
    const importSource = async (site: string, from: string | undefined): Promise<SigninImportResult> => {
      try {
        const scope = siteScope(site)
        const { all, result } = await candidates(scope)
        const matches = from ? result.filter(c => c.source.id === from) : result.filter(c => c.dto.available)
        if (!matches.length) return { status: 'unavailable', reason: from ? result.find(c => c.source.id === from)?.dto.reason ?? reasons.missing : result.length === 1 ? result[0].dto.reason : reasons.missing }
        if (matches.length !== 1) return { status: 'unavailable', reason: reasons.choose }
        const chosen = matches[0]
        if (!chosen.dto.available || !chosen.store) return { status: 'unavailable', reason: chosen.dto.reason }
        const batch = machine.platform === 'darwin' ? [...new Set(all.filter(s => s.family === 'chromium' && !s.unavailable).map(s => s.account))].join(', ') : ''
        let stopWaiting: () => void = () => {}
        const cancelled = new Promise<'cancel'>(resolve => { stopWaiting = () => resolve('cancel'); signal.addEventListener('abort', stopWaiting, { once: true }) })
        let answer
        try {
          answer = await Promise.race([cancelled, host.confirm({ id: randomUUID(), level: 'warning', expiresInMs: 30 * 60 * 1000, confirmation: { confirmLabel: 'Import sign-in', cancelLabel: 'Cancel' }, message: `Copy ${chosen.dto.count} cookies for ${scope.host}${scope.exact ? ' only' : ' and its subdomains'} from ${chosen.dto.browser} / ${chosen.dto.profile}? Later enabled full-access sessions in this workspace share these sign-ins. The site may reject reuse or invalidate the source session. This does not resume the agent.${batch ? ` macOS will request storage-key access for all discovered browsers in one round: ${batch}. The OS may serialize its dialogs.` : ''}` })])
        } finally { signal.removeEventListener('abort', stopWaiting) }
        if (answer !== 'confirm') return { status: 'cancelled' }
        check(signal)
        // Re-discover and revalidate profile identity/OS protection before any value or key access.
        const current = (await discover(machine)).find(s => s.id === chosen.source.id)
        if (!current || current.unavailable || current.file !== chosen.source.file || current.profile !== chosen.source.profile) throw new SigninFault(current?.unavailable ?? 'changed')
        if (chosen.store.fingerprint !== await fileFingerprint(current)) throw new SigninFault('changed')
        const store = await readStore(current, scope, true, signal)
        let cookies: Awaited<ReturnType<typeof decodeStore>> = []
        try {
          if (store.fingerprint !== chosen.store.fingerprint || store.rows.length !== chosen.dto.count || store.version !== chosen.store.version) throw new SigninFault('changed')
          validateEnvelopes(store, machine)
          if (machine.platform === 'darwin') await secrets.macBatch(all)
          cookies = await decodeStore(store, current, scope, machine, secrets)
          check(signal)
          if (store.fingerprint !== await fileFingerprint(current)) throw new SigninFault('changed')
          if (machine.platform === 'win32' && appBound(await jsonFile(join(current.root, 'Local State')))) throw new SigninFault('appBound')
          const count = await host.withContext(async context => {
            // The context can take time to launch; consent fingerprint must still hold at commit.
            if (store.fingerprint !== await fileFingerprint(current)) throw new SigninFault('changed')
            return installCookies(context, cookies, signal)
          })
          try { await host.checkpoint() } catch { throw new SigninFault('uncertain') }
          return { status: 'imported', count, from: { id: current.id, browser: current.browser, profile: current.profile } }
        } finally {
          for (const cookie of cookies) cookie.value = ''
          for (const row of store.rows) { row.encrypted?.fill(0); row.value = undefined }
        }
      } catch (error) { return signal.aborted ? { status: 'cancelled' } : { status: 'unavailable', reason: publicReason(error) } }
    }
    return {
      async sources(site) { const { result } = await candidates(siteScope(site)); return result.map(c => c.dto) },
      import(site, from) {
        const key = JSON.stringify([site, from])
        if (!pending.has(key)) pending.set(key, importSource(site, from))
        return pending.get(key)!
      },
      async dispose() {
        controller.abort(); host.signal.removeEventListener('abort', abort)
        await Promise.allSettled(pending.values())
        secrets.dispose(); pending.clear()
      },
    }
  }
}
export function createSigninService(host: SigninHost): SigninService { return signinFactory(currentMachine())(host) }
