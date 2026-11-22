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
