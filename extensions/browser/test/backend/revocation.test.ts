import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fixture, http, session } from './fixtures.js'

test('caller revoke checkpoints/closes only its own workspace and a new session can restore', async () => {
  const f = await fixture()
  try {
    const a = session(); const b = session('other', '/manufactured/other')
    const first = await http(f.socket, a, '/command', { id: 'a', op: 'open', args: { url: f.origin + '/seed' } })
    await http(f.socket, b, '/command', { id: 'b', op: 'open', args: { url: f.origin } })
    let closed = false; f.contexts[0].once('close', () => { closed = true })
    f.backend.receive({ type: 'halo:caller:revoked', bindingId: a.bindingId, reason: 'session-stopped' })
    for (let i = 0; i < 100 && !closed; i++) await sleep(20)
    assert.equal(closed, true)
    assert.equal((await http(f.socket, b, '/command', { id: 'still', op: 'tabs', args: {} })).body.ok, true)
    await sleep(50)
    const restored = await http(f.socket, session('new'), '/command', { id: 'new', op: 'open', args: { url: f.origin + '/check' } })
    assert.equal(restored.body.ok, true); assert.equal(restored.body.result.viewId, first.body.result.viewId)
    const read = await http(f.socket, session('new'), '/command', { id: 'read', op: 'read', args: {} })
    assert.match(read.body.result.text, /session-restored persistent-restored/)
  } finally { await f.close() }
})
