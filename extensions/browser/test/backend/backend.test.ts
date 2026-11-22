import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { fixture, http, session, admin } from './fixtures.js'
import type { BrowserServerFrame } from '../../backend/src/protocol.js'

async function viewer(socket: string, viewId: string) {
  const ws = new WebSocket(`ws+unix://${socket}:/stream?viewId=${viewId}`, { headers: { 'x-halo-caller': Buffer.from(JSON.stringify(admin())).toString('base64url') } })
  const frames: BrowserServerFrame[] = []; const images: Buffer[] = []
  ws.on('message', (bytes, binary) => {
    if (binary) { const data = Buffer.from(bytes as Buffer); images.push(data); ws.send(JSON.stringify({ type: 'frame-ack', sequence: data.readUInt32BE() })) }
    else frames.push(JSON.parse(bytes.toString()))
  })
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'subscribe', protocol: 1 }))
  return { ws, frames, images, send: (frame: unknown) => ws.send(JSON.stringify(frame)) }
}
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await sleep(20) }; assert.fail('fixture event did not arrive') }

test('private routes, request dedupe, session/workspace separation and newer-human handoff fencing', async () => {
  const f = await fixture()
  try {
    assert.equal(f.contexts.length, 0); assert.deepEqual(f.messages[0], { type: 'ready' })
    assert.equal((await http(f.socket, null, '/status')).status, 401)
    assert.equal((await http(f.socket, admin(), '/command', { id: 'x', op: 'read', args: {} })).status, 403)
    const a = session(); const request = { id: 'open', op: 'open', args: { url: f.origin } }
    const opened = await http(f.socket, a, '/command', request)
    assert.equal(opened.body.ok, true)
    assert.deepEqual((await http(f.socket, a, '/command', request)).body, opened.body)
    assert.equal((await http(f.socket, a, '/command', { ...request, args: { url: f.origin + '/next' } })).status, 400)
    assert.equal((await http(f.socket, session('two'), '/command', { id: 'busy', op: 'read', args: {} })).body.status, 'busy')
    const other = await http(f.socket, session('two', '/manufactured/other'), '/command', { id: 'other', op: 'open', args: { url: f.origin } })
    assert.equal(other.body.ok, true); assert.equal(f.contexts.length, 2)
    assert.equal((await http(f.socket, session('two', '/manufactured/other'), '/operations/open')).status, 404)
    const shot = await http(f.socket, a, '/command', { id: 'shot', op: 'screenshot', args: {} })
    assert.ok(shot.body.ok && shot.body.result?.artifactId, `screenshot HTTP ${shot.status}: ${shot.body.error?.code ?? shot.body.status ?? 'missing-result'}`)
    assert.equal((await http(f.socket, a, '/artifacts/' + shot.body.result.artifactId)).status, 200)
    assert.equal((await http(f.socket, session('two'), '/artifacts/' + shot.body.result.artifactId)).status, 403)
    const handoff = await http(f.socket, a, '/command', { id: 'handoff', op: 'handoff', args: {} })
    assert.equal(handoff.body.result.status, 'waiting-for-user')
    assert.equal((await http(f.socket, a, '/command', { id: 'read', op: 'read', args: {} })).body.status, 'waiting-for-user')
    assert.equal((await http(f.socket, a, '/artifacts/' + shot.body.result.artifactId)).status, 403)
    assert.equal((await http(f.socket, a, '/operations/open')).status, 403)
    assert.equal((await http(f.socket, a, '/command', { id: 'same', op: 'control.resume', args: {} })).body.result.status, 'waiting-for-user')
    f.backend.receive({ type: 'halo:caller:updated', bindingId: a.bindingId, userTurnId: 'turn2' })
    assert.equal((await http(f.socket, a, '/command', { id: 'old-key', op: 'control.resume', args: {} })).body.result.status, 'waiting-for-user')
    assert.equal((await http(f.socket, session('two', a.projectId, 'turn2'), '/command', { id: 'wrong', op: 'control.resume', args: {} })).body.status, 'busy')
    assert.equal((await http(f.socket, session('one', a.projectId, 'turn2'), '/command', { id: 'resume', op: 'control.resume', args: {} })).body.result.status, 'ok')
  } finally { await f.close() }
})

test('live refs, scripted actions, popup tabs, input validation and two viewers with one input owner', async () => {
  const f = await fixture()
  const peers: WebSocket[] = []
  try {
    const a = session()
    const open = await http(f.socket, a, '/command', { id: 'open', op: 'open', args: { url: f.origin } })
    const read = await http(f.socket, a, '/command', { id: 'read', op: 'read', args: {} })
    const button = read.body.result.refs.find((ref: { name: string }) => ref.name === 'Click me')
    assert.ok(button)
    assert.equal((await http(f.socket, a, '/command', { id: 'click', op: 'click', args: { snapshotId: read.body.result.snapshotId, ref: button.id } })).body.ok, true)
    await http(f.socket, a, '/command', { id: 'reread', op: 'read', args: {} })
    assert.equal((await http(f.socket, a, '/command', { id: 'stale', op: 'click', args: { snapshotId: read.body.result.snapshotId, ref: button.id } })).body.error.code, 'stale-ref')
    const one = await viewer(f.socket, open.body.result.viewId); peers.push(one.ws)
    const two = await viewer(f.socket, open.body.result.viewId); peers.push(two.ws)
    await until(() => one.images.length > 0 && two.images.length > 0)
    one.send({ type: 'takeover' }); await until(() => one.frames.some(frame => frame.type === 'state' && frame.canInput))
    two.send({ type: 'takeover' }); await until(() => two.frames.some(frame => frame.type === 'error' && frame.error.code === 'forbidden'))
    assert.ok(!two.frames.some(frame => frame.type === 'state' && frame.canInput))
    one.send({ type: 'input', event: { kind: 'pointer', event: 'down', x: -1, y: 2, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 } })
    await until(() => one.frames.some(frame => frame.type === 'error' && frame.error.code === 'invalid-request'))
    const input = f.contexts[0].pages()[0].locator('input'); const box = await input.boundingBox(); assert.ok(box)
    for (const event of ['down', 'up']) one.send({ type: 'input', event: { kind: 'pointer', event, x: box.x + 5, y: box.y + 5, button: 'left', buttons: event === 'down' ? 1 : 0, clickCount: 1, modifiers: 0 } })
    one.send({ type: 'input', event: { kind: 'text', text: 'manufactured-中文' } })
    await until(() => one.frames.filter(frame => frame.type === 'state').length > 4)
    await sleep(100); assert.equal(await input.inputValue(), 'manufactured-中文')
    one.send({ type: 'visible', visible: false }); two.send({ type: 'visible', visible: false })
    await until(() => one.frames.some(frame => frame.type === 'state' && frame.state.control.fps === 0 && frame.state.control.driver === 'user'))
    const count = one.images.length; await sleep(600); assert.equal(one.images.length, count)
    const beforeVisible = one.images.length; one.send({ type: 'visible', visible: true })
    await until(() => one.images.length > beforeVisible)
    const popup = await f.contexts[0].newPage(); await popup.goto(f.origin + '/next')
    await until(() => one.frames.some(frame => frame.type === 'state' && frame.state.tabs.length === 2))
    const state = [...one.frames].reverse().find(frame => frame.type === 'state')
    assert.ok(state?.type === 'state'); assert.equal(state.state.activeTabId, open.body.result.tab.id)
    assert.ok(!JSON.stringify(f.messages).includes('manufactured-中文'))
  } finally { for (const peer of peers) peer.terminate(); await f.close() }
})
