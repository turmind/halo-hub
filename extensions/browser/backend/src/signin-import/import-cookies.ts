import type { BrowserContext, CDPSession, Route } from 'playwright'
import { check, SigninFault, type ImportCookie } from './types.js'

const identity = (cookie: ImportCookie) => JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey?.topLevelSite ?? null, cookie.partitionKey?.hasCrossSiteAncestor ?? null])
/** Apply only affected keys; pause existing page script/network while the short CDP transaction runs. */
export async function installCookies(context: BrowserContext, cookies: ImportCookie[], signal: AbortSignal): Promise<number> {
  check(signal)
  // Context routes do not intercept service-worker traffic. A live worker prevents a faithful
  // paused transaction; do not pretend page-only script suspension also pauses workers.
  if (context.serviceWorkers().length || context.pages().some(page => page.workers().length)) throw new SigninFault('activeWorkers')
  const sessions: CDPSession[] = []
  const paused: CDPSession[] = []
  const block = (route: Route) => route.abort()
  let routed = false
  try {
    const pages = context.pages().length ? context.pages() : [await context.newPage()]
    await context.route('**/*', block); routed = true
    for (const page of pages) {
      const session = await context.newCDPSession(page); sessions.push(session)
      await session.send('Emulation.setScriptExecutionDisabled', { value: true }); paused.push(session)
      await session.send('Page.stopLoading')
    }
    const cdp = sessions[0]
    const before = (await cdp.send('Storage.getCookies')).cookies
    const snapshot = new Map<string, ImportCookie>()
    const wanted = new Set(cookies.map(identity))
    for (const cookie of before) {
      if (cookie.partitionKeyOpaque || !wanted.has(identity(cookie))) { cookie.value = ''; continue }
      const saved: ImportCookie = { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, ...(cookie.session ? {} : { expires: cookie.expires }), ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}), sourceScheme: cookie.sourceScheme, sourcePort: cookie.sourcePort, priority: cookie.priority }
      snapshot.set(identity(saved), saved)
    }
    const unique = new Map(cookies.map(cookie => [identity(cookie), cookie]))
    if (unique.size !== cookies.length) throw new SigninFault('format')
    const changed = cookies.filter(cookie => {
      const old = snapshot.get(identity(cookie))
      return !old || (old.expires === undefined) !== (cookie.expires === undefined) || Object.entries(cookie).some(([field, value]) => JSON.stringify(value) !== JSON.stringify(old[field as keyof ImportCookie]))
    })
    check(signal)
    try {
      if (changed.length) await cdp.send('Network.setCookies', { cookies: changed })
      check(signal)
    } catch {
      try {
        // deleteCookies without partitionKey also deletes partitioned siblings. Expire only newly
        // created exact keys; overwrite existing keys directly with their original attributes.
        const restore = changed.map(cookie => snapshot.get(identity(cookie)) ?? { ...cookie, expires: 1 })
        if (restore.length) await cdp.send('Network.setCookies', { cookies: restore })
      } catch { throw new SigninFault('uncertain') }
      throw new SigninFault('target')
    }
    return cookies.length
  } finally {
    for (const session of paused) await session.send('Emulation.setScriptExecutionDisabled', { value: false }).catch(() => {})
    for (const session of sessions) await session.detach().catch(() => {})
    if (routed) await context.unroute('**/*', block).catch(() => {})
  }
}
