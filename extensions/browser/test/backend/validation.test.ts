import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commandFrom, callerFrom } from '../../backend/src/validation.js'
import { validateInput, InputDispatcher } from '../../backend/src/input.js'
import { publicError, safeUrl } from '../../backend/src/errors.js'
import type { CDPSession } from 'playwright'

test('command ingress rejects arbitrary CDP, invalid URLs, refs, and unbounded inputs', () => {
  for (const body of [null, { id: 'x', op: 'eval', args: {} }, { id: 'x', op: 'open', args: { url: 'file:///profile' } }, { id: 'x', op: 'open', args: { url: 'https://user:password@example.invalid' } }, { id: 'x', op: 'type', args: { snapshotId: 'snap', ref: 'r1', text: 'x'.repeat(4097) } }, { id: 'x', op: 'scroll', args: { dx: Infinity, dy: 0 } }]) assert.throws(() => commandFrom(body))
  assert.throws(() => callerFrom({ 'x-halo-caller': 'not-json' }))
  assert.equal(safeUrl('https://user:password@example.invalid/?q=fixture'), 'https://example.invalid/?q=fixture')
  assert.ok(!JSON.stringify(publicError(new Error('manufactured-cookie-canary'))).includes('canary'))
})

test('input validation and blur release all held keys/buttons without logging text', async () => {
  for (const value of [{ kind: 'key', event: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 16 }, { kind: 'text', text: 'x'.repeat(4097) }, { kind: 'wheel', x: 0, y: 800, deltaX: 0, deltaY: 1, modifiers: 0 }]) assert.throws(() => validateInput(value))
  const events: Array<{ method: string; params: any }> = []
  const cdp = { send: async (method: string, params: unknown) => { events.push({ method, params }) } } as unknown as CDPSession
  const input = new InputDispatcher(cdp)
  await input.send(validateInput({ kind: 'key', event: 'down', key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifiers: 8 }))
  await input.send(validateInput({ kind: 'pointer', event: 'down', x: 10, y: 10, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 }))
  await input.send({ kind: 'release-all' })
  assert.equal(events[2].params.type, 'keyUp'); assert.equal(events[3].params.type, 'mouseReleased')
  assert.ok(events.slice(2).every(event => event.params.modifiers === 0))
})
