import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserBackend } from '../../backend/src/backend.js'
import type { SigninImportResult } from '../../backend/src/protocol.js'
import { session } from './fixtures.js'

for (const outcome of ['cancelled', 'unavailable'] as const) test(`explicit retry after ${outcome} preserves request dedupe, handoff and successful import`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-signin-retry-'))
  let imports = 0
  const backend = new BrowserBackend({ dataDir: directory, send: () => {}, signin: () => ({
    sources: async () => [], dispose: async () => {},
    import: async (): Promise<SigninImportResult> => {
      imports++
      if (imports === 1) return outcome === 'cancelled' ? { status: outcome } : { status: outcome, reason: 'Manufactured unavailable source.' }
      return { status: 'imported', count: 1, from: { id: 'fixture', browser: 'Fixture', profile: 'Manufactured' } }
    },
  }) })
  try {
    const caller = session()
    const request = { id: 'first', op: 'signin-import' as const, args: { site: '127.0.0.1' } }
    const first = await backend.command(caller, request)
    assert.ok(first.ok && 'result' in first && 'status' in first.result)
    assert.equal(first.result.status, outcome)
    assert.equal(imports, 1) // Completion alone never starts another import.
    const blocked = await backend.command(caller, { ...request, id: 'too-early' })
    assert.ok('status' in blocked && blocked.status === 'waiting-for-user')
    const newer = session('one', caller.projectId, 'turn2')
    await backend.command(newer, { id: 'resume', op: 'control.resume', args: {} })
    assert.deepEqual(await backend.command(newer, request), first) // Same request ID is still a retry of the transport only.
    assert.equal(imports, 1)
    const retried = await backend.command(newer, { ...request, id: 'explicit-retry' })
    assert.ok(retried.ok && 'result' in retried && 'status' in retried.result)
    assert.equal(retried.result.status, 'imported'); assert.equal(imports, 2)
    const latest = session('one', caller.projectId, 'turn3')
    assert.deepEqual(await backend.command(latest, { ...request, id: 'do-not-replay-success' }), retried)
    assert.equal(imports, 2)
  } finally { await backend.close(); await rm(directory, { recursive: true, force: true }) }
})
