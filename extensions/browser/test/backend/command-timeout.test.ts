import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { BrowserBackend } from '../../backend/src/backend.js'
import { fixture, fixtureLauncher, session } from './fixtures.js'

test('a slow command is bounded and closes its context instead of later mutating', async () => {
  const f = await fixture(); let closed = false
  const backend = new BrowserBackend({ dataDir: join(f.directory, 'slow'), send: () => {}, commandTimeoutMs: 100, launch: async (...args) => {
    const context = await fixtureLauncher(...args)
    context.on('close', () => { closed = true })
    await context.route('**/stall', async route => { await sleep(500); await route.fulfill({ body: 'late', contentType: 'text/html' }).catch(() => {}) })
    return context
  } })
  try {
    const start = performance.now()
    const response = await backend.command(session(), { id: 'slow', op: 'open', args: { url: f.origin + '/stall' } })
    assert.equal('status' in response && response.status, 'running'); assert.ok(performance.now() - start < 1000)
    for (let i = 0; i < 150 && !closed; i++) await sleep(20)
    assert.equal(closed, true)
  } finally { await backend.close(); await f.close() }
})
