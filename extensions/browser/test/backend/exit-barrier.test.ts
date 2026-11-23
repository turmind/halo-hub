import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { BrowserContext } from 'playwright'
import { BROWSER_LIMITS } from '../../backend/src/protocol.js'
import type { WorkspaceBrowser } from '../../backend/src/workspace.js'
import type { InputDispatcher } from '../../backend/src/input.js'
import { fixture, http, session } from './fixtures.js'

for (const timeout of [false, true]) test(`immediate reopen ${timeout ? 'refuses after bounded wait' : 'waits for 500ms delayed termination'} before reusing the profile`, { timeout: 15000 }, async t => {
  const f = await fixture(); t.after(async () => { t.mock.restoreAll(); await f.close() })
  const caller = session(); const next = { ...caller, userTurnId: 'turn2' }
  await http(f.socket, caller, '/command', { id: 'open', op: 'open', args: { url: f.origin + '/seed' } })
  const workspace = (f.backend as unknown as { workspaces: Map<string, WorkspaceBrowser> }).workspaces.get(caller.projectId)!
  const context = f.contexts[0]; const exited = new Promise<void>(resolve => { context.once('close', () => resolve()) }); let didExit = false
  void exited.then(() => { didExit = true })
  const kill = process.kill.bind(process); const close = context.close.bind(context)
  const timers: ReturnType<typeof setTimeout>[] = []
  const killMock = t.mock.method(process, 'kill', ((pid: number, signal?: string | number) => {
    if (signal !== 'SIGKILL') return kill(pid, signal)
    timers.push(setTimeout(() => { try { kill(pid, signal) } catch {} }, 500))
    return true
  }) as typeof process.kill)
  // Simulate a slow OS termination: neither issuing kill nor requesting close is completion.
  const closeMock = t.mock.method(context, 'close', async () => { await exited; await close() })
  t.after(async () => { killMock.mock.restore(); closeMock.mock.restore(); for (const timer of timers) clearTimeout(timer); await close().catch(() => {}) })
  const state = workspace as unknown as { input: InputDispatcher }
  t.mock.method(state.input, 'send', async () => { throw new Error('manufactured release failure') })
  const checkpoint = t.mock.method(workspace.store, 'checkpoint')
  const backend = f.backend as unknown as { launch: (...args: any[]) => Promise<BrowserContext> }
  const launch = backend.launch
  t.mock.method(backend, 'launch', async (...args: any[]) => { assert.equal(didExit, true, 'launch raced the old profile'); return launch(...args) })
  const schedule = globalThis.setTimeout
  const timerMock = timeout ? t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => schedule(callback, delay === BROWSER_LIMITS.contextCloseTimeoutMs ? 50 : delay, ...args)) as typeof setTimeout) : undefined
  workspace.handoff(caller); workspace.updateMarker(caller.bindingId, next.userTurnId)
  const failed = await http(f.socket, next, '/command', { id: 'fail-release', op: 'press', args: { key: 'Escape' } })
  assert.equal(failed.body.ok, false); assert.equal(failed.body.error.code, 'unavailable')
  assert.equal(workspace.stopping, true); assert.equal(checkpoint.mock.callCount(), 0)
  const start = performance.now()
  const reopened = await http(f.socket, next, '/command', { id: 'immediate', op: 'open', args: { url: f.origin + '/check' } })
  const elapsed = performance.now() - start
  if (timeout) {
    assert.equal(reopened.body.error.code, 'unavailable'); assert.equal(f.contexts.length, 1)
    assert.ok(elapsed < 1000); assert.equal(didExit, false)
    const retry = await http(f.socket, next, '/command', { id: 'still-stopping', op: 'open', args: { url: f.origin + '/check' } })
    assert.equal(retry.body.error.code, 'unavailable'); assert.equal(f.contexts.length, 1)
    assert.equal(closeMock.mock.callCount(), 1); assert.equal(checkpoint.mock.callCount(), 0)
    timerMock?.mock.restore()
    await exited; await sleep(10)
    assert.equal((await http(f.socket, next, '/command', { id: 'after-exit', op: 'open', args: { url: f.origin + '/check' } })).body.ok, true)
  } else {
    assert.equal(reopened.body.ok, true, JSON.stringify(reopened.body))
    assert.ok(elapsed >= 400, `reopen waited only ${elapsed.toFixed(1)}ms`)
  }
  assert.equal(f.contexts.length, 2)
  assert.match(await f.contexts[1].pages()[0].locator('body').innerText(), /session-restored/)
  t.diagnostic(`immediate reopen: ${elapsed.toFixed(1)}ms, ${timeout ? 'unavailable until exit' : 'old exit before launch'}`)
})
