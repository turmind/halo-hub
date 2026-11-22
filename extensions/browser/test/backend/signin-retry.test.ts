import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserBackend } from '../../backend/src/backend.js'
import type { SigninImportResult } from '../../backend/src/protocol.js'
import { http, session } from './fixtures.js'

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

test('equivalent site spellings deduplicate pending and successful imports but not distinct sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-signin-scope-'))
  let imports = 0; let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const backend = new BrowserBackend({ dataDir: directory, send: () => {}, commandTimeoutMs: 10, signin: () => ({
    sources: async () => [], dispose: async () => {},
    import: async () => { imports++; await gate; return { status: 'imported', count: 1, from: { id: 'fixture', browser: 'Fixture', profile: 'Manufactured' } } },
  }) })
  try {
    const caller = session()
    const request = { id: 'canonical', op: 'signin-import' as const, args: { site: 'example.com', from: 'one' } }
    const pending = await backend.command(caller, request)
    assert.equal(pending.id, 'canonical')
    const equivalent = { id: 'equivalent', op: 'signin-import' as const, args: { site: 'https://EXAMPLE.com/path', from: 'one' } }
    assert.equal((await backend.command(caller, equivalent)).id, 'canonical'); assert.equal(imports, 1)
    release()
    const newer = session('one', caller.projectId, 'turn2')
    const completed = await backend.command(newer, request)
    assert.ok(completed.ok && 'result' in completed && 'status' in completed.result && completed.result.status === 'imported')
    assert.deepEqual(await backend.command(newer, equivalent), completed); assert.equal(imports, 1)
    await assert.rejects(backend.command(newer, { ...equivalent, id: request.id }), /Invalid/)
    await backend.command(newer, { id: 'resume', op: 'control.resume', args: {} })
    await backend.command(newer, { ...equivalent, id: 'different-source', args: { ...equivalent.args, from: 'two' } })
    assert.equal(imports, 2)
  } finally { release(); await backend.close(); await rm(directory, { recursive: true, force: true }) }
})

test('independent HTTP import requests share the successful implicit source alias after newer-turn resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-signin-alias-'))
  let imports = 0; let services = 0
  const backend = new BrowserBackend({ dataDir: directory, send: () => {}, signin: () => {
    services++
    return { sources: async () => [], dispose: async () => {}, import: async () => {
      imports++; return { status: 'imported', count: 1, from: { id: 'resolved-source', browser: 'Fixture', profile: 'Manufactured' } }
    } }
  } })
  const socket = join(directory, 'backend.sock'); await backend.listen(socket)
  try {
    const first = await http(socket, session(), '/command', { id: 'implicit', op: 'signin-import', args: { site: 'example.com' } })
    assert.equal(first.body.result.status, 'imported')
    const newer = session('one', session().projectId, 'turn2')
    const resumed = await http(socket, newer, '/command', { id: 'resume', op: 'control.resume', args: {} })
    assert.equal(resumed.body.result.status, 'ok')
    const second = await http(socket, newer, '/command', { id: 'explicit', op: 'signin-import', args: { site: 'https://EXAMPLE.COM/path', from: 'resolved-source' } })
    assert.deepEqual(second.body, first.body); assert.equal(imports, 1); assert.equal(services, 1)
    await http(socket, newer, '/command', { id: 'distinct', op: 'signin-import', args: { site: 'example.com', from: 'other-source' } })
    assert.equal(imports, 2); assert.equal(services, 2)
  } finally { await backend.close(); await rm(directory, { recursive: true, force: true }) }
})
