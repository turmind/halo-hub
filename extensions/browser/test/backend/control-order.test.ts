import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BrowserContext, CDPSession, Page } from 'playwright'
import { WorkspaceBrowser, type Viewer } from '../../backend/src/workspace.js'
import { InputDispatcher } from '../../backend/src/input.js'
import { Hooks } from '../../backend/src/hooks.js'
import { admin, session, fixtureLauncher, fixture, http } from './fixtures.js'

function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done }), resolve } }

for (const delayed of ['keyup', 'viewer-input'] as const) test(`automatic return waits for ${delayed} before agent input`, async t => {
  const hooks = new Hooks(() => {})
  const workspace = new WorkspaceBrowser('/manufactured/workspace', '/unused', fixtureLauncher, hooks, () => {}, () => {})
  const caller = session(); workspace.acquire(caller)
  const viewer: Viewer = { bufferedAmount: 0, send: () => {}, json: () => {}, close: () => {} }
  const held = new Set<string>(); const events: string[] = []; const entered = deferred(); const release = deferred()
  const cdp = { send: async (_method: string, event: { type: string; code: string }) => {
    events.push(`${event.type}:start:${event.code}`)
    if (delayed === 'keyup' && event.type === 'keyUp' && event.code === 'ControlLeft' || delayed === 'viewer-input' && event.type === 'keyDown' && event.code === 'ShiftLeft') { entered.resolve(); await release.promise }
    if (event.type === 'keyDown') held.add(event.code); else held.delete(event.code)
    events.push(`${event.type}:end:${event.code}`)
  } } as unknown as CDPSession
  const input = new InputDispatcher(cdp)
  const page = { url: () => 'about:blank', keyboard: { press: async () => { assert.deepEqual([...held], []); events.push('agent') } } } as unknown as Page
  const state = workspace as unknown as { input: InputDispatcher; inputOwner?: Viewer; pages: Map<string, Page>; activeTabId: string; viewers: Map<Viewer, unknown> }
  state.input = input; state.pages.set('tab', page); state.activeTabId = 'tab'
  state.viewers.set(viewer, { caller: admin(), visible: true, subscribed: true })
  t.mock.method(workspace, 'ensureContext', async () => ({} as BrowserContext))
  t.mock.method(workspace, 'checkpointNow', async () => {})
  t.after(async () => { release.resolve(); await workspace.close(); hooks.close() })
  await workspace.viewerMessage(viewer, { type: 'takeover' })
  await workspace.viewerMessage(viewer, { type: 'input', event: { kind: 'key', event: 'down', key: 'Control', code: 'ControlLeft', keyCode: 17, modifiers: 2 } })
  let pending: Promise<void> | undefined
  if (delayed === 'viewer-input') {
    pending = workspace.viewerMessage(viewer, { type: 'input', event: { kind: 'key', event: 'down', key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifiers: 10 } })
    await entered.promise
  }
  const epoch = workspace.revision; const next = { ...caller, userTurnId: 'turn2' }
  workspace.updateMarker(caller.bindingId, next.userTurnId!)
  assert.equal(workspace.acquire(next), 'ok')
  assert.equal(workspace.driver, 'agent'); assert.equal(state.inputOwner, undefined); assert.equal(workspace.revision, epoch + 1)
  const action = workspace.command(next, { id: 'action', op: 'press', args: { key: 'Escape' } }, new AbortController().signal, workspace.revision)
  if (delayed === 'keyup') await entered.promise
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(!events.includes('agent'))
  if (delayed === 'viewer-input') assert.ok(!events.some(event => event.startsWith('keyUp')))
  release.resolve(); await pending; await action
  assert.deepEqual([...held], [])
  const expected = ['keyDown:start:ControlLeft', 'keyDown:end:ControlLeft']
  if (delayed === 'viewer-input') expected.push('keyDown:start:ShiftLeft', 'keyDown:end:ShiftLeft')
  expected.push('keyUp:start:ControlLeft', 'keyUp:end:ControlLeft')
  if (delayed === 'viewer-input') expected.push('keyUp:start:ShiftLeft', 'keyUp:end:ShiftLeft')
  expected.push('agent'); assert.deepEqual(events, expected)
})

for (const failure of ['closed-page', 'live-page'] as const) test(`release failure on ${failure} does not leave a ready workspace with a rejected barrier`, async t => {
  const f = await fixture(); t.after(() => f.close())
  const caller = session(); const next = { ...caller, userTurnId: 'turn2' }
  await http(f.socket, caller, '/command', { id: 'open', op: 'open', args: { url: f.origin + '/seed' } })
  const workspace = (f.backend as unknown as { workspaces: Map<string, WorkspaceBrowser> }).workspaces.get(caller.projectId)!
  const state = workspace as unknown as { input?: InputDispatcher; cdp: CDPSession }
  const context = f.contexts[0]; const page = context.pages()[0]
  const replacement = await context.newPage(); await replacement.goto(f.origin + '/check')
  await workspace.checkpointNow()
  const viewer: Viewer = { bufferedAmount: 0, send: () => {}, json: () => {}, close: () => {} }
  workspace.attach(viewer, admin())
  // Visibility is enough for input routing; frame delivery is not part of this ordering test.
  ;(workspace as unknown as { viewers: Map<Viewer, unknown> }).viewers.set(viewer, { caller: admin(), visible: true, subscribed: true })
  await workspace.viewerMessage(viewer, { type: 'takeover' })
  for (const [key, code, keyCode] of [['Control', 'ControlLeft', 17], ['Shift', 'ShiftLeft', 16], ['Alt', 'AltLeft', 18]] as const) {
    await workspace.viewerMessage(viewer, { type: 'input', event: { kind: 'key', event: 'down', key, code, keyCode, modifiers: 0 } })
  }
  const oldInput = state.input; const send = state.cdp.send.bind(state.cdp); let keyups = 0
  t.mock.method(state.cdp, 'send', (async (method: string, params: { type?: string }) => {
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') {
      if (failure === 'live-page') throw new Error('manufactured transport failure')
      if (++keyups === 1) { const result = await send(method as any, params as any); await page.close(); return result }
    }
    return send(method as any, params as any)
  }) as typeof state.cdp.send)
  workspace.updateMarker(caller.bindingId, next.userTurnId)
  const result = await http(f.socket, next, '/command', { id: 'return', op: 'press', args: { key: 'Escape' } })
  if (failure === 'closed-page') {
    assert.ok(keyups >= 2); assert.equal(page.isClosed(), true); assert.notEqual(state.input, oldInput)
    assert.equal(result.body.ok, true); await workspace.inputReleased
    assert.equal((await http(f.socket, next, '/command', { id: 'read-after-close', op: 'read', args: {} })).body.ok, true)
    assert.equal((await http(f.socket, next, '/command', { id: 'press', op: 'press', args: { key: 'Escape' } })).body.ok, true)
    assert.equal((await http(f.socket, next, '/status')).body.status, 'ready')
  } else {
    assert.equal(result.body.ok, false); assert.equal(result.body.error.code, 'unavailable')
    assert.equal(workspace.runtime.status, 'unavailable'); await workspace.inputReleased
    assert.notEqual((await http(f.socket, next, '/status')).body.status, 'ready')
    const reopened = await http(f.socket, next, '/command', { id: 'fresh-open', op: 'open', args: { url: f.origin + '/check' } })
    assert.equal(reopened.body.ok, true); assert.equal(f.contexts.length, 2)
    assert.match(await f.contexts[1].pages()[0].locator('body').innerText(), /session-restored/)
    assert.notEqual((f.backend as unknown as { workspaces: Map<string, WorkspaceBrowser> }).workspaces.get(caller.projectId), workspace)
  }
})

for (const op of ['signin-import', 'signin-sources'] as const) test(`${op} rechecks ownership after viewer retakes during release`, async t => {
  const f = await fixture(); t.after(() => f.close())
  const caller = session(); const next = { ...caller, userTurnId: 'turn2' }
  await http(f.socket, caller, '/command', { id: 'open', op: 'open', args: { url: f.origin } })
  const workspace = (f.backend as unknown as { workspaces: Map<string, WorkspaceBrowser> }).workspaces.get(caller.projectId)!
  const state = workspace as unknown as { input: InputDispatcher; viewers: Map<Viewer, unknown> }
  const viewer: Viewer = { bufferedAmount: 0, send: () => {}, json: () => {}, close: () => {} }
  state.viewers.set(viewer, { caller: admin(), visible: true, subscribed: true })
  await workspace.viewerMessage(viewer, { type: 'takeover' })
  const entered = deferred(); const release = deferred(); t.after(() => release.resolve())
  t.mock.method(state.input, 'send', async (event: Parameters<InputDispatcher['send']>[0]) => { if (event.kind === 'release-all') { entered.resolve(); await release.promise } })
  let serviceCalls = 0
  ;(f.backend as unknown as { options: { signin: () => never } }).options.signin = () => { serviceCalls++; throw new Error('service must not start') }
  workspace.updateMarker(caller.bindingId, next.userTurnId)
  const pending = http(f.socket, next, '/command', { id: 'signin', op, args: { site: f.origin } })
  await entered.promise
  await workspace.viewerMessage(viewer, { type: 'takeover' })
  release.resolve(); const result = await pending
  assert.equal(result.body.status, 'waiting-for-user'); assert.equal(serviceCalls, 0)
  assert.equal(workspace.pendingImport, false); assert.equal(workspace.driver, 'user')
})
