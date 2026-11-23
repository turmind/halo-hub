import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorkspaceBrowser, type Viewer } from '../../backend/src/workspace.js'
import { Hooks } from '../../backend/src/hooks.js'
import { fixture, fixtureLauncher, http, session, admin } from './fixtures.js'
import type { BrowserCommandRequest, BrowserServerFrame } from '../../backend/src/protocol.js'

const peer = (frames: BrowserServerFrame[] = []): Viewer => ({ bufferedAmount: 0, send: () => {}, json: frame => frames.push(frame), close: () => {} })

test('user control permits owner reads/artifacts but fences every action until a new human marker', async () => {
  const f = await fixture(); const caller = session()
  const command = (request: Omit<BrowserCommandRequest, 'id'>, who = caller) => http(f.socket, who, '/command', { id: crypto.randomUUID(), ...request })
  try {
    await command({ op: 'open', args: { url: f.origin } })
    const initial = await command({ op: 'read', args: {} })
    const ref = initial.body.result.refs.find((r: any) => r.name === 'Click me')
    await command({ op: 'handoff', args: {} })
    for (const op of ['read', 'tabs', 'screenshot'] as const) {
      const result = await command({ op, args: {} })
      assert.equal(result.body.ok, true, op)
      if (op === 'screenshot') assert.equal((await http(f.socket, caller, '/artifacts/' + result.body.result.artifactId)).status, 200)
      assert.equal((await http(f.socket, caller, '/operations/' + result.body.id)).status, 200)
      assert.equal((await command({ op, args: {} }, session('other'))).body.status, 'busy')
    }
    assert.equal((await http(f.socket, caller, '/status')).status, 200)
    assert.equal((await http(f.socket, session('other'), '/status')).body.status, 'busy')
    for (const action of [
      { op: 'open', args: { url: f.origin } }, { op: 'click', args: { snapshotId: initial.body.result.snapshotId, ref: ref.id } },
      { op: 'type', args: { snapshotId: initial.body.result.snapshotId, ref: ref.id, text: 'normal' } },
      { op: 'press', args: { key: 'Escape' } }, { op: 'scroll', args: { dx: 0, dy: 1 } },
      { op: 'select-tab', args: { tabId: initial.body.result.tabId } }, { op: 'close-tab', args: { tabId: initial.body.result.tabId } },
    ] as BrowserCommandRequest[]) assert.equal((await command(action)).body.status, 'waiting-for-user', action.op)
    f.backend.receive({ type: 'halo:caller:updated', bindingId: caller.bindingId, userTurnId: 'turn2' })
    const current = await command({ op: 'read', args: {} }, session('one', caller.projectId, 'turn2'))
    const target = current.body.result.refs.find((r: any) => r.name === 'Click me')
    assert.equal((await command({ op: 'click', args: { snapshotId: current.body.result.snapshotId, ref: target.id } }, session('one', caller.projectId, 'turn2'))).body.ok, true)
    assert.equal(await f.contexts[0].pages()[0].locator('button').innerText(), 'Clicked')
  } finally { await f.close() }
})

test('ownerless viewer lets first claimant read then act in the same turn; agent closes final tab', async () => {
  const f = await fixture(); const hooks = new Hooks(() => {}); const frames: BrowserServerFrame[] = []
  const w = new WorkspaceBrowser(session().projectId, f.directory, fixtureLauncher, hooks, () => {}, () => {})
  try {
    const viewer = peer(frames); w.attach(viewer, admin()); await w.viewerMessage(viewer, { type: 'subscribe', protocol: 1 })
    await w.viewerMessage(viewer, { type: 'takeover' })
    const caller = session(); assert.equal(w.acquire(caller, true), 'ok')
    const read = await w.command(caller, { id: 'read', op: 'read', args: {} }, new AbortController().signal, w.revision)
    assert.ok('ariaSnapshot' in read); assert.equal(w.driver, 'user')
    w.pendingImport = true; assert.equal(w.acquire(caller), 'waiting-for-user'); w.pendingImport = false
    assert.equal(w.acquire(caller), 'ok'); assert.equal(w.driver, 'agent')
    assert.ok(frames.some(frame => frame.type === 'state' && !frame.canInput && frame.state.control.driver === 'agent'))
    const old = w.state().activeTabId!
    await w.command(caller, { id: 'close', op: 'close-tab', args: { tabId: old } }, new AbortController().signal, w.revision)
    assert.equal(w.state().tabs.length, 1); assert.notEqual(w.state().activeTabId, old); assert.equal(w.state().tabs[0].url, 'about:blank')
    const context = await w.ensureContext(); await context.newPage()
    assert.equal(w.state().tabs.length, 2)
    await w.command(caller, { id: 'close-again', op: 'close-tab', args: { tabId: w.state().activeTabId! } }, new AbortController().signal, w.revision)
    assert.equal(w.state().tabs.length, 1)
  } finally { await w.close(); hooks.close(); await f.close() }
})

test('read keeps internal snapshot identities out of labels and exposes only actionable refs', async () => {
  const f = await fixture()
  try {
    const caller = session()
    await http(f.socket, caller, '/command', { id: 'open', op: 'open', args: { url: f.origin } })
    const page = f.contexts[0].pages()[0]
    await page.setContent('<h1>Heading</h1><div role="group" aria-label="Group"><button onclick="this.textContent=\'Clicked\'">X</button><label>Ordinary<input value="ordinary [ref=e999]"></label></div>')
    const response = await http(f.socket, caller, '/command', { id: 'read', op: 'read', args: {} })
    assert.equal(response.body.ok, true)
    const { ariaSnapshot, snapshotId, refs } = response.body.result
    assert.deepEqual(ariaSnapshot.match(/\[ref=e\d+\]/g), ['[ref=e999]']) // Keep literal field values, not generated identities.
    const target = refs.find((ref: any) => ref.name === 'X')
    assert.match(target.id, /^r\d+$/)
    assert.equal((await http(f.socket, caller, '/command', { id: 'click', op: 'click', args: { snapshotId, ref: target.id } })).body.ok, true)
    assert.equal(await page.locator('button').innerText(), 'Clicked')
  } finally { await f.close() }
})

test('read redacts password values including quoted/shadow inputs, without changing forms or ordinary values', async () => {
  const f = await fixture()
  try {
    const caller = session()
    await http(f.socket, caller, '/command', { id: 'open', op: 'open', args: { url: f.origin } })
    const page = f.contexts[0].pages()[0]
    await page.setContent('<label>Ordinary<input value="ordinary-value"></label><label>Password<input type="password"></label><div id="shadow"></div><textarea>normal textarea</textarea>')
    const password = 'secret: "quote" \\ symbols • [ref=e1]: tail'
    await page.locator('input[type=password]').evaluate(node => node.setAttribute('aria-label', 'Password "quoted" [ref=e2]: label'))
    await page.locator('input[type=password]').fill(password)
    await page.locator('#shadow').evaluate(node => { node.attachShadow({ mode: 'open' }).innerHTML = '<input type="password" aria-label="Shadow password" value="shadow-secret">' })
    const raw = await page.locator('body').ariaSnapshot()
    assert.ok(raw.includes('shadow-secret')) // Pinned upstream snapshot really includes password values.
    const result = await http(f.socket, caller, '/command', { id: 'read', op: 'read', args: {} })
    assert.equal(result.body.ok, true)
    const snapshot = result.body.result.ariaSnapshot
    assert.match(snapshot, /••••/); assert.match(snapshot, /ordinary-value/); assert.match(snapshot, /normal textarea/)
    assert.ok(!JSON.stringify(result.body).includes('shadow-secret')); assert.ok(!snapshot.includes('secret:'))
    assert.equal(await page.locator('input[type=password]').first().inputValue(), password)
    assert.equal(await page.locator('input[type=password]').last().inputValue(), 'shadow-secret')
  } finally { await f.close() }
})
