import type { BrowserContext, CDPSession, Route } from 'playwright'
import { check, SigninFault, type ImportCookie, type SigninHost } from './types.js'

const identity = (cookie: ImportCookie) => JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey?.topLevelSite ?? null, cookie.partitionKey?.hasCrossSiteAncestor ?? null])
/** The undo record belongs to the whole import, not just the setCookies call. */
class CookieImportTransaction {
  private context?: BrowserContext
  private closed = false
  private restore: ImportCookie[] = []
  private dirty = false
  private mutated = false
  private rollbackFailed = false
  private onClose = () => { this.closed = true }
  constructor(private cookies: ImportCookie[]) {}
  get needsRollback() { return this.dirty }
  get needsCheckpoint() { return this.mutated }

  async apply(context: BrowserContext, signal: AbortSignal): Promise<number> {
    check(signal)
    // Context routes do not intercept worker traffic; page-only pause is not sufficient there.
    if (context.serviceWorkers().length || context.pages().some(page => page.workers().length)) throw new SigninFault('activeWorkers')
    this.context = context; context.on('close', this.onClose)
    const sessions: CDPSession[] = []
    const paused: CDPSession[] = []
    const block = (route: Route) => route.abort()
    let routed = false
    try {
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
        const wanted = new Set(this.cookies.map(identity))
        for (const cookie of before) {
          if (cookie.partitionKeyOpaque || !wanted.has(identity(cookie))) { cookie.value = ''; continue }
          const saved: ImportCookie = { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, ...(cookie.session ? {} : { expires: cookie.expires }), ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}), sourceScheme: cookie.sourceScheme, sourcePort: cookie.sourcePort, priority: cookie.priority }
          snapshot.set(identity(saved), saved)
        }
        if (wanted.size !== this.cookies.length) throw new SigninFault('format')
        const changed = this.cookies.filter(cookie => {
          const old = snapshot.get(identity(cookie))
          return !old || (old.expires === undefined) !== (cookie.expires === undefined) || Object.entries(cookie).some(([field, value]) => JSON.stringify(value) !== JSON.stringify(old[field as keyof ImportCookie]))
        })
        // Expire only newly created exact keys; deleteCookies can also delete partitioned siblings.
        this.restore = changed.map(cookie => snapshot.get(identity(cookie)) ?? { ...cookie, expires: 1 })
        check(signal)
        if (changed.length) {
          this.dirty = true; this.mutated = true
          await cdp.send('Network.setCookies', { cookies: changed })
        }
        check(signal)
      } catch (error) {
        // Restore write failures before resuming page scripts; later cleanup failures undo below.
        if (this.dirty) await this.rollback(context)
        throw error
      } finally {
        // Finish all cleanup even if one step fails. A failure must still reach the undo path.
        let failed = false
        for (const session of paused) await session.send('Emulation.setScriptExecutionDisabled', { value: false }).catch(() => { failed = true })
        for (const session of sessions) await session.detach().catch(() => { failed = true })
        if (routed) await context.unroute('**/*', block).catch(() => { failed = true })
        if (failed) throw new SigninFault('target')
      }
      check(signal) // Includes abort while detach/unroute was awaiting.
      if (this.closed) throw new SigninFault('uncertain')
      return this.cookies.length
    } catch (error) {
      // Still inside the host lock: compensate before its post-callback abort check can throw.
      if (this.dirty) await this.rollback(context)
      throw error
    }
  }

  async rollback(context: BrowserContext): Promise<void> {
    if (!this.dirty) return
    if (this.rollbackFailed || this.closed || context !== this.context) throw new SigninFault('uncertain')
    let session: CDPSession | undefined
    try {
      // Apply's CDP sessions may already be detached. Cleanup must not inherit the aborted signal.
      session = await context.newCDPSession(context.pages()[0] ?? await context.newPage())
      await session.send('Network.setCookies', { cookies: this.restore })
      await session.detach(); session = undefined
      if (this.closed) throw new SigninFault('uncertain')
      this.dirty = false
    } catch {
      // A failed undo cannot be confirmed; outer cleanup must not retry or mask it with abort.
      this.rollbackFailed = true
      throw new SigninFault('uncertain')
    } finally { await session?.detach().catch(() => {}) }
  }
  commit() {
    if (this.closed) throw new SigninFault('uncertain')
    this.dirty = false
  }
  verifyRestored() {
    if (this.dirty || this.closed) throw new SigninFault('uncertain')
  }
  dispose() {
    this.context?.off('close', this.onClose)
    for (const cookie of this.restore) cookie.value = ''
    this.restore = []
  }
}

/** Success is linearized at a completed checkpoint; aborts after it cannot rewrite the result. */
export async function commitCookies(host: SigninHost, cookies: ImportCookie[], signal: AbortSignal, beforeApply: () => Promise<void> = async () => {}): Promise<number> {
  const transaction = new CookieImportTransaction(cookies)
  try {
    await host.withContext(async context => {
      check(signal)
      await beforeApply()
      return transaction.apply(context, signal)
    })
    check(signal) // Includes abort/rejection at the outer context boundary, before persistence.
    await host.checkpoint()
    transaction.commit()
    return cookies.length
  } catch (error) {
    if (transaction.needsRollback) {
      try { await host.withContext(context => transaction.rollback(context)) }
      catch { throw new SigninFault('uncertain') }
    }
    if (transaction.needsCheckpoint) {
      // A concurrent checkpoint could have persisted the tentative cookies: persist the undo too.
      try { await host.checkpoint(); transaction.verifyRestored() }
      catch { throw new SigninFault('uncertain') }
    }
    // In particular, never turn a failed/uncertain rollback into an ordinary cancellation.
    if (error instanceof SigninFault && error.reason === 'uncertain') throw error
    if (signal.aborted) throw new SigninFault('cancelled')
    throw transaction.needsCheckpoint ? new SigninFault('target') : error
  } finally { transaction.dispose() }
}
