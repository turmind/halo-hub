import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import type { BrowserContext } from 'playwright'
import { WorkspaceBrowser, type Viewer } from '../../backend/src/workspace.js'
import { Hooks } from '../../backend/src/hooks.js'
import { ProfileStore } from '../../backend/src/profile-store.js'
import { BROWSER_LIMITS, type BrowserInputEvent, type BrowserServerFrame } from '../../backend/src/protocol.js'
import { admin, fixture, fixtureLauncher, http, session } from './fixtures.js'

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(25) }
  assert.fail('fixture state did not settle')
}
function workspaceFixture(t: TestContext) {
  const hooks = new Hooks(() => {})
  let expired = 0
  const workspace = new WorkspaceBrowser('/manufactured/workspace', '/unused-fixture-no-launch', fixtureLauncher, hooks, () => {}, () => { expired++ })
  t.after(async () => { await workspace.close(); hooks.close() })
  t.mock.method(workspace, 'ensureContext', async () => ({} as BrowserContext))
  const frames: BrowserServerFrame[] = []
  const viewer = (): Viewer => ({ bufferedAmount: 0, send: () => {}, json: frame => frames.push(frame), close: () => {} })
  return { workspace, viewer, frames, expired: () => expired }
}

test('background Set-Cookie login and logout checkpoint the session journal without agent commands', async () => {
  const f = await fixture()
  try {
    const caller = session()
    assert.equal((await http(f.socket, caller, '/command', { id: 'open', op: 'open', args: { url: f.origin } })).body.ok, true)
    const journal = join(new ProfileStore(join(f.directory, 'data'), caller.projectId).directory, 'session-cookies.json')
    assert.equal(await readFile(journal, 'utf8'), '[]')
    const page = f.contexts[0].pages()[0]
    await page.evaluate(async () => { await fetch('/seed') })
    await until(async () => JSON.parse(await readFile(journal, 'utf8')).some((cookie: { name: string }) => cookie.name === 'session'))
    await page.evaluate(async () => { await fetch('/logout') })
    await until(async () => await readFile(journal, 'utf8') === '[]')
  } finally { await f.close() }
})

test('ownerless takeover is claimed by the first agent, fences its current turn and rejects other sessions', async t => {
  const { workspace, viewer } = workspaceFixture(t)
  const peer = viewer(); workspace.attach(peer, admin())
  await workspace.viewerMessage(peer, { type: 'subscribe', protocol: 1 })
  await workspace.viewerMessage(peer, { type: 'takeover' })
  assert.equal(workspace.owner, undefined); assert.equal(workspace.driver, 'user')
  const caller = session()
  assert.equal(workspace.acquire(caller), 'waiting-for-user')
  assert.equal(workspace.state().control.ownerSessionId, caller.sessionId)
  assert.equal(workspace.acquire(session('two')), 'busy')
  assert.equal(workspace.resume(caller).status, 'waiting-for-user')
  await workspace.detach(peer)
  assert.equal(workspace.driver, 'user') // A claimed handoff survives viewer closure.
  workspace.updateMarker(caller.bindingId, 'turn2')
  assert.equal(workspace.resume(caller).status, 'waiting-for-user')
  assert.equal(workspace.resume(session('one', caller.projectId, 'turn2')).status, 'ok')
  assert.equal(workspace.driver, 'agent')
})

test('unclaimed takeover releases only when the last viewer closes', async t => {
  const { workspace, viewer } = workspaceFixture(t)
  const one = viewer(); const two = viewer()
  workspace.attach(one, admin()); workspace.attach(two, admin())
  await workspace.viewerMessage(one, { type: 'subscribe', protocol: 1 })
  await workspace.viewerMessage(two, { type: 'subscribe', protocol: 1 })
  await workspace.viewerMessage(one, { type: 'takeover' })
  await workspace.detach(one); assert.equal(workspace.driver, 'user')
  await workspace.detach(two); assert.equal(workspace.driver, 'idle'); assert.equal(workspace.busy, false)
  assert.equal(workspace.acquire(session()), 'ok')
})

test('unclaimed user control expires after five minutes without input even with a visible viewer', async t => {
  const { workspace, viewer, expired } = workspaceFixture(t)
  const peer = viewer(); workspace.attach(peer, admin())
  await workspace.viewerMessage(peer, { type: 'subscribe', protocol: 1 })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await workspace.viewerMessage(peer, { type: 'takeover' })
  t.mock.timers.tick(BROWSER_LIMITS.idleLeaseMs - 1); assert.equal(expired(), 0)
  t.mock.timers.tick(1); assert.equal(expired(), 1)
})

test('activity cancels an armed lease and an already-fired timer rechecks running work', async t => {
  const { workspace, expired } = workspaceFixture(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  workspace.acquire(session()); workspace.activityStarted()
  t.mock.timers.tick(BROWSER_LIMITS.idleLeaseMs); assert.equal(expired(), 0)
  assert.equal(workspace.running, 1); assert.equal(workspace.busy, true)
  workspace.running--; workspace.activityEnded()
  workspace.running++ // Simulate activity racing an already armed callback.
  t.mock.timers.tick(BROWSER_LIMITS.idleLeaseMs); assert.equal(expired(), 0)
  workspace.running--; workspace.activityEnded()
  t.mock.timers.tick(BROWSER_LIMITS.idleLeaseMs); assert.equal(expired(), 1)
})

test('initialization alone cancels the idle lease until launch settles', async t => {
  const hooks = new Hooks(() => {}); let expired = 0; let release!: () => void; let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const launching = new Promise<void>(resolve => { started = resolve })
  const workspace = new WorkspaceBrowser('/manufactured/workspace', '/unused-fixture-no-launch', async () => { started(); await gate; throw new Error('manufactured launch failure') }, hooks, () => {}, () => { expired++ })
  t.mock.method(workspace.store, 'init', async () => {})
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    workspace.acquire(session())
    const pending = workspace.ensureContext(); const failed = assert.rejects(pending, /manufactured/)
    await launching
    t.mock.timers.tick(BROWSER_LIMITS.idleLeaseMs); assert.equal(expired, 0); assert.equal(workspace.life.signal.aborted, false)
    release(); await failed
    t.mock.timers.tick(BROWSER_LIMITS.idleLeaseMs); assert.equal(expired, 1)
  } finally { release(); await workspace.close(); hooks.close() }
})

for (const mode of ['context', 'browser'] as const) test(`${mode} exit invalidates live state and the next open launches a fresh context`, async () => {
  const f = await fixture()
  try {
    const caller = session()
    const open = { id: 'before-exit', op: 'open', args: { url: f.origin + '/seed' } }
    assert.equal((await http(f.socket, caller, '/command', open)).body.ok, true)
    const journal = join(new ProfileStore(join(f.directory, 'data'), caller.projectId).directory, 'session-cookies.json')
    const saved = await readFile(journal, 'utf8')
    const context = f.contexts[0]
    const view = await http(f.socket, admin(), '/view', {})
    const peer = new WebSocket(`ws+unix://${f.socket}:/stream?viewId=${view.body.viewId}`, { headers: { 'x-halo-caller': Buffer.from(JSON.stringify(admin())).toString('base64url') } })
    const frames: BrowserServerFrame[] = []
    peer.on('message', bytes => frames.push(JSON.parse(bytes.toString())))
    await once(peer, 'open'); const closed = once(peer, 'close')
    let started!: () => void
    const navigating = new Promise<void>(resolve => { started = resolve })
    await context.route('**/held', async route => { started(); await sleep(200); await route.abort().catch(() => {}) })
    const pending = http(f.socket, caller, '/command', { ...open, id: 'interrupted', args: { url: f.origin + '/held' } })
    await navigating
    if (mode === 'context') await context.close(); else await context.browser()!.close()
    await closed
    assert.ok(frames.some(frame => frame.type === 'runtime' && frame.runtime.status === 'unavailable'))
    assert.equal((await pending).body.ok, false)
    assert.notEqual((await http(f.socket, caller, '/status')).body.status, 'ready')
    assert.equal(await readFile(journal, 'utf8'), saved)
    assert.equal((await http(f.socket, caller, '/command', { ...open, id: 'after-exit', args: { url: f.origin + '/check' } })).body.ok, true)
    assert.equal(f.contexts.length, 2)
    assert.match(await f.contexts[1].pages()[0].locator('body').innerText(), /session-restored/)
  } finally { await f.close() }
})

test('pointer movement and releases never dirty checkpoints; dirty input is debounced until interaction settles', async t => {
  const { workspace, viewer } = workspaceFixture(t)
  const peer = viewer(); workspace.attach(peer, admin())
  await workspace.viewerMessage(peer, { type: 'subscribe', protocol: 1 })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await workspace.viewerMessage(peer, { type: 'takeover' })
  const checkpoint = t.mock.method(workspace, 'checkpointNow', async () => {})
  const move: BrowserInputEvent = { kind: 'pointer', event: 'move', x: 20, y: 20, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 }
  const send = (event: BrowserInputEvent) => workspace.viewerMessage(peer, { type: 'input', event })
  for (let i = 0; i < 100; i++) { await send(move); t.mock.timers.tick(100) }
  await send({ ...move, event: 'up' }); await send({ kind: 'key', event: 'up', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0 }); await send({ kind: 'release-all' })
  t.mock.timers.tick(1000); await workspace.serial(async () => {})
  assert.equal(checkpoint.mock.callCount(), 0)
  await send({ ...move, event: 'down', button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 0; i < 20; i++) { t.mock.timers.tick(100); await send(move) }
  assert.equal(checkpoint.mock.callCount(), 0)
  t.mock.timers.tick(500); await workspace.serial(async () => {})
  assert.equal(checkpoint.mock.callCount(), 1)
})
