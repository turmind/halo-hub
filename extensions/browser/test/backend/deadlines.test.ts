import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { BrowserBackend } from '../../backend/src/backend.js'
import { fixture, fixtureLauncher, http, session } from './fixtures.js'
import { WorkspaceBrowser } from '../../backend/src/workspace.js'
import { Hooks } from '../../backend/src/hooks.js'
import type { ExtensionNoticeBackendMessage } from '../../contracts/halo-core/extension-notices.js'
import { BROWSER_LIMITS } from '../../backend/src/protocol.js'

test('initialization returns running by deadline, then pushes completion without polling', { timeout: 60000 }, async t => {
  const f = await fixture(); const messages: unknown[] = []
  let notify!: () => void; let launching!: () => void; let release!: () => void
  const notice = new Promise<void>(resolve => { notify = resolve })
  const started = new Promise<void>(resolve => { launching = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const backend = new BrowserBackend({ dataDir: join(f.directory, 'delayed'), send: message => { messages.push(message); if (message.type === 'halo:notice' && message.notice.message.startsWith('Browser operation completed')) notify() }, launch: async (...args) => { launching(); await gate; return fixtureLauncher(...args) } })
  try {
    // Advance only the initialization response deadline. The old 100 ms override
    // also killed real navigation/checkpoint work under concurrent Chromium load.
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pending = backend.command(session(), { id: 'delayed', op: 'open', args: { url: f.origin } })
    await started
    t.mock.timers.tick(BROWSER_LIMITS.commandTimeoutMs)
    const response = await pending
    assert.equal('status' in response && response.status, 'running')
    t.mock.timers.reset(); release()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([notice, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No completion notice')), 45000) })]) }
    finally { clearTimeout(timer) }
    const completed = await backend.command(session(), { id: 'delayed', op: 'open', args: { url: f.origin } })
    assert.equal(completed.ok, true); assert.ok('result' in completed)
    assert.ok(messages.some(message => (message as { type: string }).type === 'halo:notice'))
  } finally { t.mock.timers.reset(); release(); await backend.close(); await f.close() }
})

test('queued agent work is fenced even after human resumes before queued work starts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-queue-'))
  const hooks = new Hooks(() => {})
  const workspace = new WorkspaceBrowser('/manufactured/workspace', directory, fixtureLauncher, hooks, () => {}, () => {})
  try {
    const a = session(); workspace.acquire(a); await workspace.ensureContext()
    const epoch = workspace.revision
    let release!: () => void
    const gate = workspace.serial(() => new Promise<void>(resolve => { release = resolve }))
    await sleep(10)
    const queued = workspace.command(a, { id: 'queued', op: 'read', args: {} }, new AbortController().signal, epoch)
    workspace.handoff(a)
    workspace.updateMarker(a.bindingId, 'turn2')
    assert.equal(workspace.resume(session('one', a.projectId, 'turn2')).status, 'ok')
    release(); await gate
    await assert.rejects(queued, /does not control/)
  } finally { await workspace.close(); hooks.close(); await rm(directory, { recursive: true, force: true }) }
})

test('takeover records newest owner marker, not old bearer marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-marker-'))
  const hooks = new Hooks(() => {})
  const workspace = new WorkspaceBrowser('/manufactured/workspace', directory, fixtureLauncher, hooks, () => {}, () => {})
  try {
    const a = session(); workspace.acquire(a); workspace.updateMarker(a.bindingId, 'turn2'); workspace.handoff()
    assert.equal(workspace.resume(a).status, 'waiting-for-user')
    assert.equal(workspace.resume(session('one', a.projectId, 'turn2')).status, 'waiting-for-user')
    workspace.updateMarker(a.bindingId, 'turn3')
    assert.equal(workspace.resume(session('one', a.projectId, 'turn3')).status, 'ok')
  } finally { await workspace.close(); hooks.close(); await rm(directory, { recursive: true, force: true }) }
})

test('injected sign-in confirmation blocks resume, accepts one bound answer and does not fabricate chat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-signin-port-'))
  const messages: unknown[] = []; let copies = 0; let disposed = 0
  const backend = new BrowserBackend({ dataDir: directory, send: message => messages.push(message), commandTimeoutMs: 50, signin: host => ({
    sources: async () => [],
    import: async () => {
      const decision = await host.confirm({ id: 'copy-fixture', message: 'Copy manufactured sign-in into this workspace shared profile?', level: 'warning', expiresInMs: 1000, confirmation: { confirmLabel: 'Copy', cancelLabel: 'Cancel' } })
      if (decision !== 'confirm') return { status: 'cancelled' }
      copies++; return { status: 'imported', count: 1, from: { id: 'fixture', browser: 'Fixture', profile: 'Manufactured' } }
    }, dispose: async () => { disposed++ },
  }) })
  try {
    await backend.listen(join(directory, 'socket'))
    const a = session()
    const request = { id: 'import', op: 'signin-import' as const, args: { site: '127.0.0.1' } }
    const result = await backend.command(a, request)
    assert.equal(result.ok && 'result' in result && !Array.isArray(result.result) && 'status' in result.result && result.result.status, 'waiting-for-user')
    const resumed = await backend.command(session('one', a.projectId, 'turn2'), { id: 'resume', op: 'control.resume', args: {} })
    assert.equal(resumed.ok && 'result' in resumed && !Array.isArray(resumed.result) && 'status' in resumed.result && resumed.result.status, 'waiting-for-user')
    const notice = messages.find(message => (message as any).notice?.id === 'copy-fixture') as Extract<ExtensionNoticeBackendMessage, { type: 'halo:notice' }>
    backend.receive({ type: 'halo:notice:accepted', id: notice.notice.id, requestId: notice.requestId, generation: 'g1', expiresAt: new Date(Date.now() + 1000).toISOString() })
    backend.receive({ type: 'halo:notice:result', id: notice.notice.id, generation: 'g1', decision: 'confirm' })
    backend.receive({ type: 'halo:notice:result', id: notice.notice.id, generation: 'g1', decision: 'confirm' })
    await sleep(20)
    const operation = await http(join(directory, 'socket'), session('one', a.projectId, 'turn2'), '/operations/import')
    assert.equal(operation.body.response.result.status, 'imported'); assert.equal(copies, 1); assert.equal(disposed, 1)
    const repeat = await backend.command(session('one', a.projectId, 'turn2'), { ...request, id: 'same-import-new-turn' })
    assert.equal(repeat.ok && 'result' in repeat && !Array.isArray(repeat.result) && 'status' in repeat.result && repeat.result.status, 'imported')
    assert.equal(copies, 1)
    assert.ok(messages.every(message => ['ready', 'busy', 'halo:notice', 'halo:notice:withdraw'].includes((message as any).type)))
  } finally { await backend.close(); await rm(directory, { recursive: true, force: true }) }
})
