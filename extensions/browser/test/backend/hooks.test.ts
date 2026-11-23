import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hooks } from '../../backend/src/hooks.js'
import { session } from './fixtures.js'
import type { ExtensionNoticeBackendMessage } from '../../contracts/halo-core/extension-notices.js'

test('notice acceptance/generation, cancellation and busy no-op IPC', async () => {
  const messages: unknown[] = []; const hooks = new Hooks(message => messages.push(message))
  try {
    hooks.setBusy(true); hooks.setBusy(true); hooks.setBusy(false)
    assert.equal(messages.length, 2)
    const pending = hooks.notice(session(), { id: 'notice', message: 'Manufactured consent', level: 'info', expiresInMs: 1000, confirmation: { confirmLabel: 'Copy', cancelLabel: 'Cancel' } }, new AbortController().signal)
    const sent = messages[2] as Extract<ExtensionNoticeBackendMessage, { type: 'halo:notice' }>
    hooks.receive({ type: 'halo:notice:accepted', requestId: sent.requestId, id: 'notice', generation: 'current', expiresAt: new Date(Date.now() + 1000).toISOString() })
    hooks.receive({ type: 'halo:notice:result', id: 'notice', generation: 'old', decision: 'confirm' })
    hooks.receive({ type: 'halo:notice:result', id: 'notice', generation: 'current', decision: 'cancel' })
    assert.equal(await pending, 'cancel')
    const abort = new AbortController()
    const cancelled = hooks.notice(session(), { id: 'abort', message: 'Manufactured consent', level: 'info', expiresInMs: 1000 }, abort.signal)
    abort.abort(); assert.equal(await cancelled, 'withdrawn')
  } finally { hooks.close() }
})

test('open notices withdraw by workspace/session/view; completion remains independent', async () => {
  const messages: any[] = []; const hooks = new Hooks(message => messages.push(message)); const signal = new AbortController().signal
  try {
    hooks.open(session(), 'view', 'Open', signal)
    const first = messages.at(-1).notice.id
    hooks.open(session(), 'view', 'Handoff', signal)
    assert.equal(messages.at(-2).id, first)
    const second = messages.at(-1).notice.id
    assert.deepEqual(messages.at(-1).notice.action, { type: 'open-canvas', viewId: 'view' })
    hooks.completed(session(), 'view', 'Completed operation-id', signal)
    const completed = messages.at(-1).notice.id
    const count = messages.length
    hooks.withdrawOpen(session('other'), 'view'); hooks.withdrawOpen(session('one', '/other'), 'view'); hooks.withdrawOpen(session(), 'other')
    assert.equal(messages.length, count)
    hooks.withdrawOpen(session(), 'view'); hooks.withdrawOpen(session(), 'view')
    assert.deepEqual(messages.slice(count), [{ type: 'halo:notice:withdraw', id: second }])
    assert.equal(messages.some(message => message.type === 'halo:notice:withdraw' && message.id === completed), false)
    await Promise.resolve()
  } finally { hooks.close() }
})
