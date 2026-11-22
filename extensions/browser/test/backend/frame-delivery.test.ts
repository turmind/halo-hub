import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { FrameDelivery, type FramePeer } from '../../backend/src/frame-delivery.js'

test('2→10→2 uses monotonic deadlines and delivers the sparse final image', async () => {
  const delivery = new FrameDelivery(); const sends: Array<{ at: number; data: string }> = []
  const peer: FramePeer = { bufferedAmount: 0, send: packet => { sends.push({ at: performance.now(), data: packet.subarray(4).toString() }); delivery.ack(peer, packet.readUInt32BE()) } }
  try {
    delivery.add(peer); delivery.capture(Buffer.from('first')); await sleep(30)
    delivery.capture(Buffer.from('agent')); await sleep(520)
    delivery.mode(true); delivery.capture(Buffer.from('user')); await sleep(150)
    delivery.mode(false); delivery.capture(Buffer.from('final')); await sleep(550)
    assert.deepEqual(sends.map(send => send.data), ['first', 'agent', 'user', 'final'])
    assert.ok(sends[1].at - sends[0].at >= 500)
    assert.ok(sends[2].at - sends[1].at >= 100)
    assert.ok(sends[3].at - sends[2].at >= 500)
  } finally { delivery.close() }
})
test('slow viewer retains latest independently, one outstanding, capped buffering', async () => {
  const delivery = new FrameDelivery(); const slow: Buffer[] = []; const fast: Buffer[] = []
  const a: FramePeer = { bufferedAmount: 0, send: data => slow.push(data) }
  const b: FramePeer = { bufferedAmount: 0, send: data => { fast.push(data); delivery.ack(b, data.readUInt32BE()) } }
  try {
    delivery.mode(true); delivery.add(a); delivery.add(b); delivery.capture(Buffer.from('one')); await sleep(30)
    delivery.capture(Buffer.from('two')); await sleep(130)
    delivery.capture(Buffer.from('last')); await sleep(130)
    assert.equal(slow.length, 1); assert.equal(fast.length, 3)
    a.bufferedAmount = 512 * 1024; delivery.ack(a, slow[0].readUInt32BE()); await sleep(30); assert.equal(slow.length, 1)
    a.bufferedAmount = 0; delivery.retry(); await sleep(30)
    assert.equal(slow.length, 2); assert.equal(slow[1].subarray(4).toString(), 'last')
    assert.equal(delivery.capture(Buffer.alloc(512 * 1024)), false)
  } finally { delivery.close() }
})
