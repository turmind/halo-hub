import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { BrowserContext } from 'playwright'
import { BrowserBackend } from '../../backend/src/backend.js'
import { WorkspaceBrowser } from '../../backend/src/workspace.js'
import { ProfileStore } from '../../backend/src/profile-store.js'
import type { SigninCommit, SigninHost } from '../../backend/src/signin-service.js'
import { signinFactory } from '../../backend/src/signin-import/index.js'
import { home, chromiumStore, canary } from '../../backend/src/signin-import/fixtures.js'
import { reasons, type ImportCookie } from '../../backend/src/signin-import/types.js'
import { BROWSER_LIMITS, type BrowserCommandResponse } from '../../backend/src/protocol.js'
import { http, session, fixtureLauncher, fixture as browserFixture } from './fixtures.js'

function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done }), resolve } }
async function fixture(t: TestContext) {
  const f = await home(); await chromiumStore(join(f.dir, '.config/chromium'))
  const caller = session(); const events: string[] = []; const emitter = new EventEmitter()
  const old: ImportCookie = { name: 'fixture', value: 'old', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', sourceScheme: 'Secure', sourcePort: 443, priority: 'Medium' }
  let jar = [structuredClone(old)]; let persisted = structuredClone(jar); let closed = false; let checkpoints = 0; let launches = 0
  const hooks = { set: async (_count: number) => {}, checkpoint: async (_count: number) => {}, boundary: async () => {} }
  let sets = 0
  const context = Object.assign(emitter, {
    serviceWorkers: () => [], pages: () => [{ workers: () => [] }], route: async () => {}, unroute: async () => {},
    newCDPSession: async () => ({
      async send(method: string, args?: { cookies: ImportCookie[] }) {
        if (closed) throw new Error('manufactured closed target')
        if (method === 'Storage.getCookies') return { cookies: jar.map(cookie => ({ ...cookie, session: cookie.expires === undefined })) }
        if (method === 'Network.setCookies') { events.push('set'); jar = structuredClone(args!.cookies); await hooks.set(++sets) }
        return {}
      }, detach: async () => {},
    }),
    close: async () => { closed = true; events.push('close'); emitter.emit('close') },
  }) as unknown as BrowserContext
  let workspace!: WorkspaceBrowser; let host!: SigninHost; let target!: SigninCommit
  t.mock.method(WorkspaceBrowser.prototype, 'ensureContext', async function (this: WorkspaceBrowser) {
    workspace = this
    const state = this as unknown as { context?: BrowserContext }
    if (!state.context) { state.context = context; launches++ }
    return state.context
  })
  t.mock.method(ProfileStore.prototype, 'checkpoint', async (value: BrowserContext) => {
    assert.equal(value, context); assert.equal(closed, false)
    events.push('checkpoint'); persisted = structuredClone(jar); await hooks.checkpoint(++checkpoints)
  })
  t.mock.method(ProfileStore.prototype, 'save', async () => true)
  const completed = deferred(); let completionMessage = ''
  const backend = new BrowserBackend({ dataDir: join(f.dir, 'data'), launch: fixtureLauncher, send: message => {
    if (message.type === 'halo:notice' && message.notice.message.startsWith('Browser operation completed')) { completionMessage = message.notice.message; completed.resolve() }
  }, signin: bound => {
    host = bound
    return signinFactory(f.machine)({ ...bound, confirm: async () => 'confirm', withCommit: work => bound.withCommit(async commit => {
      target = commit
      return work({ ...commit, withContext: async task => { const value = await commit.withContext(task); await hooks.boundary(); return value } })
    }) })
  } })
  const socket = join(f.dir, 'backend.sock'); await backend.listen(socket)
  t.after(async () => { await backend.close(); await f.close() })
  const request = { id: 'import', op: 'signin-import' as const, args: { site: 'example.com' } }
  return { backend, socket, caller, request, hooks, context, events, completed, get completionMessage() { return completionMessage },
    get workspace() { return workspace }, get host() { return host }, get target() { return target },
    get jar() { return jar }, get persisted() { return persisted }, get checkpoints() { return checkpoints }, get launches() { return launches }, get closed() { return closed },
    start: () => backend.command(caller, request), revoke: () => backend.receive({ type: 'halo:caller:revoked', bindingId: caller.bindingId, reason: 'session-stopped' }),
  }
}
async function result(f: Awaited<ReturnType<typeof fixture>>, pending: Promise<BrowserCommandResponse>) {
  const first = await pending
  if ('result' in first) return first
  const operation = await http(f.socket, session('one', f.caller.projectId, 'turn2'), '/operations/import')
  assert.equal(operation.body.status, 'completed')
  return operation.body.response as BrowserCommandResponse
}

test('close during import waits for original-context rollback and undo checkpoint before teardown', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred()
  f.hooks.set = async count => { if (count === 1) { entered.resolve(); await release.promise } }
  const pending = f.start(); await entered.promise
  let finished = false; const closing = f.workspace.close().then(() => { finished = true })
  await Promise.resolve(); assert.equal(f.closed, false); assert.equal(finished, false)
  release.resolve(); await closing
  const response = await result(f, pending)
  assert.ok(response.ok && 'result' in response && 'status' in response.result)
  assert.equal(response.result.status, 'cancelled'); assert.equal(f.launches, 1)
  assert.deepEqual(f.events, ['set', 'set', 'checkpoint', 'close'])
  assert.equal(f.jar[0].value, 'old'); assert.deepEqual(f.persisted, f.jar)
})

test('handoff cannot overlap commit, background checkpoint waits, and commit capabilities expire', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred()
  f.hooks.set = async count => { if (count === 1) { entered.resolve(); await release.promise } }
  const pending = f.start(); await entered.promise
  const revision = f.workspace.revision
  assert.throws(() => f.workspace.handoff(), /unavailable/)
  assert.equal(f.workspace.revision, revision)
  let scanned = false
  const background = f.workspace.serial(async () => { await f.workspace.checkpointNow(); scanned = true })
  await Promise.resolve(); assert.equal(scanned, false); assert.equal(f.checkpoints, 0)
  await assert.rejects(f.workspace.checkpointNow(), /unavailable/)
  release.resolve(); const response = await result(f, pending); await background
  assert.ok(response.ok && 'result' in response && 'status' in response.result)
  assert.equal(response.result.status, 'imported'); assert.equal(scanned, true)
  await assert.rejects(f.target.cleanup(async () => {}), /unavailable/)
  await assert.rejects(f.target.checkpoint(), /unavailable/)
  f.workspace.handoff()
})

test('cleanup and undo checkpoint remain callable after outer abort and lease revocation without relaunch', async t => {
  const f = await fixture(t)
  f.hooks.boundary = async () => { f.revoke() }
  const response = await result(f, f.start())
  assert.ok(response.ok && 'result' in response && 'status' in response.result)
  assert.equal(response.result.status, 'cancelled')
  assert.equal(f.host.signal.aborted, true); assert.equal(f.launches, 1)
  assert.equal(f.jar[0].value, 'old'); assert.deepEqual(f.persisted, f.jar)
  assert.equal(f.checkpoints, 1)
})

for (const outcome of ['imported', 'uncertain'] as const) test(`backend preserves ${outcome} when abort arrives at the checkpoint boundary`, async t => {
  const f = await fixture(t)
  f.hooks.checkpoint = async () => { f.revoke(); if (outcome === 'uncertain') throw new Error('manufactured checkpoint failure') }
  const response = await result(f, f.start())
  assert.ok(response.ok && 'result' in response && 'status' in response.result)
  assert.equal(f.host.signal.aborted, true)
  if (outcome === 'imported') { assert.equal(response.result.status, 'imported'); assert.equal(f.persisted[0].value, canary) }
  else assert.deepEqual(response.result, { status: 'unavailable', reason: reasons.uncertain })
  const operation = await http(f.socket, session('one', f.caller.projectId, 'turn2'), '/operations/import')
  assert.equal(operation.body.status, 'completed'); assert.deepEqual(operation.body.response, response)
})

for (const outcome of ['imported', 'uncertain'] as const) test(`completion notice retains the ${outcome} distinction`, async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred()
  f.hooks.set = async count => { if (count === 1) { entered.resolve(); await release.promise } }
  if (outcome === 'uncertain') f.hooks.checkpoint = async () => { throw new Error('manufactured checkpoint failure') }
  const pending = f.start(); await entered.promise
  // Force only the response wait to resolve; the transaction itself still has its normal deadline.
  const timeout = globalThis.setTimeout
  const shortened = t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => timeout(callback, delay === BROWSER_LIMITS.commandTimeoutMs ? 5 : delay, ...args)) as typeof setTimeout)
  const waiting = await f.backend.command(f.caller, f.request); shortened.mock.restore()
  assert.ok('status' in waiting && waiting.status === 'running')
  release.resolve(); await pending; await f.completed.promise
  assert.match(f.completionMessage, /operation import/)
  assert.ok(f.completionMessage.includes(outcome === 'imported' ? 'Sign-in: imported' : reasons.uncertain))
  assert.equal(f.completionMessage.includes(canary), false)
})

test('checkpoint rejects missing, replaced and closing contexts instead of resolving as a no-op', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred()
  f.hooks.set = async count => { if (count === 1) { entered.resolve(); await release.promise } }
  const pending = f.start(); await entered.promise
  const state = f.workspace as unknown as { context?: BrowserContext; closing: boolean }
  state.context = undefined
  await assert.rejects(f.target.checkpoint(), /unavailable/)
  state.context = {} as BrowserContext
  await assert.rejects(f.target.checkpoint(), /unavailable/)
  state.context = f.context; state.closing = true
  await assert.rejects(f.target.checkpoint(), /unavailable/)
  state.closing = false; release.resolve(); await pending
  state.context = undefined; await assert.rejects(f.workspace.checkpointNow(), /unavailable/)
  state.context = f.context; state.closing = true; await assert.rejects(f.workspace.checkpointNow(), /unavailable/)
  state.closing = false
})

test('forced cleanup deadline invalidates the original context and reports uncertainty, never cancellation', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred()
  f.hooks.set = async count => { if (count === 1) { entered.resolve(); await release.promise } }
  const pending = f.start(); await entered.promise
  // Shorten only the new teardown timer; replacing timers would strand already-armed operation timers.
  const timeout = globalThis.setTimeout
  const shortened = t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => timeout(callback, delay === BROWSER_LIMITS.commandTimeoutMs ? 5 : delay, ...args)) as typeof setTimeout)
  const closing = f.workspace.close()
  await closing; shortened.mock.restore()
  const response = await result(f, pending) // Teardown must finish even if the target call has not returned.
  assert.ok(response.ok && 'result' in response)
  assert.deepEqual(response.result, { status: 'unavailable', reason: reasons.uncertain })
  assert.equal(f.checkpoints, 0); assert.equal(f.closed, true); assert.equal(f.launches, 1)
  release.resolve()
})

test('commit self-timeout removes the backend workspace so a new ID can open it again', { timeout: 15000 }, async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred()
  f.hooks.set = async count => { if (count === 1) { entered.resolve(); await release.promise } }
  const timeout = globalThis.setTimeout; const deadlines: (() => void)[] = []
  // Fire the actual armed callbacks after mutation starts, not a tiny wall-clock timer that can beat source validation.
  const timers = t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === BROWSER_LIMITS.commandTimeoutMs) deadlines.push(() => callback(...args))
    return timeout(callback, delay, ...args)
  }) as typeof setTimeout)
  const pending = f.start(); await entered.promise
  const original = f.workspace
  assert.equal(deadlines.length, 2); deadlines[1]() // Commit deadline requests backend removal.
  assert.equal(deadlines.length, 3); deadlines[2]() // Cleanup deadline invalidates the wedged target.
  await f.completed.promise; timers.mock.restore()
  const response = await result(f, pending)
  assert.ok(response.ok && 'result' in response)
  assert.deepEqual(response.result, { status: 'unavailable', reason: reasons.uncertain })
  assert.equal(f.closed, true); assert.equal(original.life.signal.aborted, true)
  release.resolve(); t.mock.restoreAll() // Reopen through the real launcher, not the closed target double.
  const site = await browserFixture(); t.after(() => site.close())
  const reopened = await http(f.socket, session('one', f.caller.projectId, 'turn2'), '/command', { id: 'reopen', op: 'open', args: { url: site.origin } })
  assert.ok(reopened.body.ok && reopened.body.result?.tab, `reopen HTTP ${reopened.status}: ${reopened.body.error?.code ?? 'missing-tab'}`)
  assert.equal(reopened.body.result.viewId, original.viewId)
})

test('backend stop shortens an in-progress live close and retains uncertain completion', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred()
  f.hooks.set = async count => { if (count === 1) { entered.resolve(); await release.promise } }
  const pending = f.start(); await entered.promise
  const liveClose = f.workspace.close()
  const timeout = globalThis.setTimeout
  const shortened = t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => timeout(callback, delay === 3000 ? 10 : delay, ...args)) as typeof setTimeout)
  await f.backend.close(); await liveClose; shortened.mock.restore()
  const first = await pending
  assert.ok(first.ok)
  assert.ok(f.completionMessage.includes(reasons.uncertain))
  assert.equal(f.checkpoints, 0); assert.equal(f.closed, true)
  await f.workspace.close(3000) // Completed close must not arm a lingering shutdown timer.
  release.resolve()
})
