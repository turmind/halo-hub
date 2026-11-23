import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { BrowserContext } from 'playwright'
import { canary, chromiumStore, home, host } from './fixtures.js'
import { signinFactory } from './index.js'
import { reasons, type ImportCookie, type SigninHost, type SigninImportResult } from './types.js'

// Stateful CDP double: successful undo must restore both the live jar and its checkpoint.
function target() {
  const controller = new AbortController(); const events = new EventEmitter()
  const old: ImportCookie = { name: 'fixture', value: 'old', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', sourceScheme: 'Secure', sourcePort: 443, priority: 'Medium' }
  const key = (cookie: ImportCookie) => JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey])
  const initial = [old, { ...old, name: 'unrelated' }, { ...old, partitionKey: { topLevelSite: 'https://other.example', hasCrossSiteAncestor: true } }]
  const jar = new Map(initial.map(cookie => [key(cookie), structuredClone(cookie)]))
  const snapshot = () => structuredClone([...jar.values()])
  const hooks = {
    set: async (_count: number) => {}, detach: async (_count: number) => {}, unroute: async () => {},
    context: async (_count: number) => {}, checkpoint: async (_count: number) => {},
  }
  const state = { sets: 0, detaches: 0, contexts: 0, checkpoints: 0, notices: 0, rejectCleanup: false, closed: false, persisted: snapshot() }
  const page = { workers: () => [] }
  const context = Object.assign(events, {
    serviceWorkers: () => [], pages: () => [page], route: async () => {}, unroute: () => hooks.unroute(),
    newCDPSession: async () => {
      if (state.closed) throw new Error(canary)
      return {
        async send(method: string, args?: { cookies: ImportCookie[] }) {
          if (state.closed) throw new Error(canary)
          if (method === 'Storage.getCookies') return { cookies: snapshot().map(cookie => ({ ...cookie, session: cookie.expires === undefined })) }
          if (method === 'Network.setCookies') {
            await hooks.set(++state.sets)
            for (const cookie of args!.cookies) {
              if (cookie.expires === 1) jar.delete(key(cookie))
              else jar.set(key(cookie), structuredClone(cookie))
            }
          }
          return {}
        },
        async detach() { await hooks.detach(++state.detaches) },
      }
    },
  }) as unknown as BrowserContext
  const target: import('../signin-service.js').SigninCommit = {
    tabId: () => 'fixture-tab',
    async withContext(work) {
      if (state.rejectCleanup && controller.signal.aborted) throw new Error(canary)
      const count = ++state.contexts
      const result = await work(context)
      await hooks.context(count)
      return result
    },
    cleanup: work => target.withContext(work),
    async checkpoint() {
      state.persisted = snapshot()
      await hooks.checkpoint(++state.checkpoints)
    },
  }
  const bound: SigninHost = { ...host(), signal: controller.signal, confirm: async () => { state.notices++; return 'confirm' }, withCommit: work => work(target) }
  return { host: bound, target, controller, state, hooks, initial, snapshot, events, close() { state.closed = true; events.emit('close') } }
}
async function fixture(t: TestContext) {
  const f = await home()
  await chromiumStore(join(f.dir, '.config/chromium'))
  const browser = target(); const service = signinFactory(f.machine)(browser.host)
  t.after(async () => { await service.dispose(); await f.close() })
  return { ...browser, service, f }
}
function restored(f: ReturnType<typeof target>) {
  assert.deepEqual(f.snapshot(), f.initial)
  assert.deepEqual(f.state.persisted, f.initial)
  assert.equal(f.events.listenerCount('close'), 0)
}
function uncertain(result: SigninImportResult) {
  assert.deepEqual(result, { status: 'unavailable', reason: reasons.uncertain })
  assert.equal(JSON.stringify(result).includes(canary), false)
}

for (const boundary of ['detach', 'unroute'] as const) test(`abort during ${boundary} restores and checkpoints before cancelled DTO`, async t => {
  const f = await fixture(t)
  if (boundary === 'detach') f.hooks.detach = async count => { if (count === 1) f.controller.abort() }
  else f.hooks.unroute = async () => { f.controller.abort() }
  assert.deepEqual(await f.service.import('example.com', undefined), { status: 'cancelled' })
  assert.equal(f.state.sets, 2); assert.equal(f.state.checkpoints, 1); restored(f)
})
for (const reject of [false, true]) test(`abort at outer withContext boundary (${reject ? 'reject' : 'return'}) compensates before cancelled DTO`, async t => {
  const f = await fixture(t)
  f.hooks.context = async count => { if (count === 1) { f.controller.abort(); if (reject) throw new Error(canary) } }
  assert.deepEqual(await f.service.import('example.com', undefined), { status: 'cancelled' })
  assert.equal(f.state.contexts, 2); assert.equal(f.state.checkpoints, 1); restored(f)
})
test('abort after withContext resolves but before checkpoint restores the same context', async t => {
  const f = await fixture(t)
  const withContext = f.target.withContext
  f.target.withContext = work => {
    const task = withContext(work)
    // This reaction precedes commitCookies' await continuation, after host resolution.
    if (f.state.contexts === 1) void task.then(() => f.controller.abort())
    return task
  }
  assert.deepEqual(await f.service.import('example.com', undefined), { status: 'cancelled' })
  assert.equal(f.state.contexts, 2); assert.equal(f.state.checkpoints, 1); restored(f)
})
test('host refusing cleanup after outer abort reports uncertain, not cancelled', async t => {
  const f = await fixture(t); f.state.rejectCleanup = true
  f.hooks.context = async () => { f.controller.abort() }
  uncertain(await f.service.import('example.com', undefined))
  assert.equal(f.state.sets, 1); assert.equal(f.state.checkpoints, 0)
  assert.equal(f.snapshot()[0].value, canary); assert.equal(f.events.listenerCount('close'), 0)
})
test('rollback failure concurrent with abort stays uncertain through the service DTO', async t => {
  const f = await fixture(t)
  f.hooks.detach = async count => { if (count === 1) f.controller.abort() }
  f.hooks.set = async count => { if (count > 1) throw new Error(canary) }
  uncertain(await f.service.import('example.com', undefined))
  assert.equal(f.state.sets, 2); assert.equal(f.snapshot()[0].value, canary); assert.equal(f.events.listenerCount('close'), 0)
})
test('failed undo cannot be hidden by a subsequent cleanup failure and abort', async t => {
  const f = await fixture(t)
  f.hooks.set = async () => { throw new Error(canary) }
  f.hooks.unroute = async () => { f.controller.abort(); throw new Error(canary) }
  uncertain(await f.service.import('example.com', undefined))
  assert.equal(f.state.sets, 2); assert.equal(f.events.listenerCount('close'), 0)
})
test('rollback detach failure stays uncertain even after the undo write succeeds', async t => {
  const f = await fixture(t)
  f.hooks.detach = async count => { if (count === 1) f.controller.abort(); else throw new Error(canary) }
  uncertain(await f.service.import('example.com', undefined))
  assert.equal(f.state.sets, 2); assert.deepEqual(f.snapshot(), f.initial)
})
test('checkpoint failure restores and checkpoints undo, reporting failure not success', async t => {
  const f = await fixture(t)
  f.hooks.checkpoint = async count => { if (count === 1) throw new Error(canary) }
  assert.deepEqual(await f.service.import('example.com', undefined), { status: 'unavailable', reason: reasons.target })
  assert.equal(f.state.sets, 2); assert.equal(f.state.checkpoints, 2); restored(f)
})
test('checkpoint failure with abort returns cancelled only after persisted undo', async t => {
  const f = await fixture(t)
  f.hooks.checkpoint = async count => { if (count === 1) { f.controller.abort(); throw new Error(canary) } }
  assert.deepEqual(await f.service.import('example.com', undefined), { status: 'cancelled' })
  assert.equal(f.state.checkpoints, 2); restored(f)
})
test('undo checkpoint failure with abort remains uncertain even when the live jar is restored', async t => {
  const f = await fixture(t)
  f.hooks.detach = async count => { if (count === 1) f.controller.abort() }
  f.hooks.checkpoint = async () => { throw new Error(canary) }
  uncertain(await f.service.import('example.com', undefined))
  assert.deepEqual(f.snapshot(), f.initial); assert.equal(f.state.checkpoints, 1)
})
test('abort at a successful checkpoint cannot rewrite imported to cancelled', async t => {
  const f = await fixture(t)
  f.hooks.checkpoint = async () => { f.controller.abort() }
  const result = await f.service.import('example.com', undefined)
  assert.equal(result.status, 'imported'); assert.equal(f.state.sets, 1); assert.equal(f.state.checkpoints, 1)
  assert.equal(f.state.persisted[0].value, canary); assert.equal(f.events.listenerCount('close'), 0)
})
for (const boundary of ['detach', 'checkpoint', 'undo-checkpoint'] as const) test(`target closes during ${boundary}: uncertain despite abort or a silent checkpoint`, async t => {
  const f = await fixture(t)
  if (boundary !== 'checkpoint') f.hooks.detach = async count => { if (count === 1) { f.controller.abort(); if (boundary === 'detach') f.close() } }
  if (boundary !== 'detach') f.hooks.checkpoint = async () => { f.close(); f.controller.abort() }
  uncertain(await f.service.import('example.com', undefined))
  assert.equal(f.events.listenerCount('close'), 0)
})
test('abort before mutation is cancelled without target writes or checkpoint', async t => {
  const f = await fixture(t)
  f.target.withContext = async () => { f.controller.abort(); throw new Error(canary) }
  assert.deepEqual(await f.service.import('example.com', undefined), { status: 'cancelled' })
  assert.equal(f.state.sets, 0); assert.equal(f.state.checkpoints, 0); restored(f)
})
test('equivalent site spellings and implicit/explicit source share one confirmation and commit', async t => {
  const f = await fixture(t)
  const [source] = await f.service.sources('example.com')
  const results = await Promise.all([
    f.service.import('example.com', undefined),
    f.service.import('https://EXAMPLE.com/path', source.id),
    f.service.import('http://example.com./other', undefined),
  ])
  assert.equal(results[0].status, 'imported'); assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0])
  assert.equal(f.state.notices, 1); assert.equal(f.state.sets, 1); assert.equal(f.state.checkpoints, 1)
  assert.deepEqual(await f.service.import('https://EXAMPLE.com/later', source.id), results[0])
  assert.equal(f.state.notices, 1); assert.equal(f.state.checkpoints, 1)
})
test('different normalized scopes do not share an import', async t => {
  const f = await fixture(t)
  await chromiumStore(join(f.f.dir, '.config/chromium'), 'Profile 1', { host: 'sub.example.com' })
  const sources = await f.service.sources('example.com'); const source = sources.find(item => item.profile === 'Profile 1')!
  const results = await Promise.all([f.service.import('example.com', source.id), f.service.import('sub.example.com', source.id)])
  assert.ok(results.every(result => result.status === 'imported')); assert.equal(f.state.notices, 2); assert.equal(f.state.checkpoints, 2)
})
test('different resolved sources do not share an import or merge accounts', async t => {
  const f = await fixture(t)
  await chromiumStore(join(f.f.dir, '.config/chromium'), 'Profile 1')
  const sources = await f.service.sources('example.com')
  assert.deepEqual(await f.service.import('example.com', undefined), { status: 'unavailable', reason: reasons.choose })
  const results = await Promise.all(sources.map(source => f.service.import('example.com', source.id)))
  assert.equal(results.length, 2); assert.ok(results.every(result => result.status === 'imported'))
  assert.equal(f.state.notices, 2); assert.equal(f.state.checkpoints, 2)
})
