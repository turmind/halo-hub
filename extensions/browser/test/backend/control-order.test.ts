import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BrowserContext, CDPSession, Page } from 'playwright'
import { WorkspaceBrowser, type Viewer } from '../../backend/src/workspace.js'
import { InputDispatcher } from '../../backend/src/input.js'
import { Hooks } from '../../backend/src/hooks.js'
import { admin, session, fixtureLauncher } from './fixtures.js'

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
