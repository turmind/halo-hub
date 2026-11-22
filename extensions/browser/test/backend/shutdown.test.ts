import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { home, chromiumStore, canary } from '../../backend/src/signin-import/fixtures.js'
import { reasons } from '../../backend/src/signin-import/types.js'
import { http, session } from './fixtures.js'

test('real entry SIGTERM bounds slow rollback and emits uncertain operation and completion before four seconds', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const f = await home(); await chromiumStore(join(f.dir, '.config/chromium'))
  const socket = join(f.dir, 'backend.sock')
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', fileURLToPath(new URL('./shutdown-preload.ts', import.meta.url)), fileURLToPath(new URL('../../backend/src/index.ts', import.meta.url))], {
    env: { ...process.env, HOME: f.dir, XDG_CONFIG_HOME: join(f.dir, '.config'), HALO_EXT_SOCKET: socket, HALO_EXT_DATA_DIR: join(f.dir, 'data') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const messages: any[] = []; let stderr = ''
  child.stderr!.on('data', bytes => { stderr += bytes.toString() })
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve })
  let applied!: () => void; const entered = new Promise<void>(resolve => { applied = resolve })
  child.on('message', (message: any) => {
    messages.push(message)
    if (message.type === 'ready') ready()
    if (message.type === 'fixture:applied') applied()
    if (message.type === 'halo:notice' && message.notice.confirmation) {
      child.send({ type: 'halo:notice:accepted', id: message.notice.id, requestId: message.requestId, generation: 'fixture' })
      child.send({ type: 'halo:notice:result', id: message.notice.id, generation: 'fixture', decision: 'confirm' })
    }
  })
  const exited = once(child, 'exit')
  try {
    await started
    const response = await http(socket, session(), '/command', { id: 'slow-undo', op: 'signin-import', args: { site: 'example.com' } })
    assert.equal(response.body.id, 'slow-undo')
    await entered
    const stop = performance.now(); child.kill('SIGTERM')
    const [code, signal] = await exited; const elapsed = performance.now() - stop
    assert.equal(code, 0); assert.equal(signal, null)
    assert.ok(elapsed >= 2900 && elapsed < 4000, `SIGTERM exit took ${elapsed.toFixed(0)}ms`)
    assert.ok(messages.some(message => message.type === 'fixture:cleanup'))
    const completed = messages.find(message => message.type === 'fixture:operation' && message.operation.status === 'completed')
    assert.deepEqual(completed?.operation.response.result, { status: 'unavailable', reason: reasons.uncertain })
    assert.ok(messages.some(message => message.type === 'halo:notice' && message.notice.message.includes('completed (slow-undo)') && message.notice.message.includes(reasons.uncertain)))
    assert.ok(!JSON.stringify(messages).includes(canary)); assert.ok(!stderr.includes(canary))
    console.log(`[BrowserTest] SIGTERM slow cleanup exit ${elapsed.toFixed(0)}ms; uncertain operation and notice delivered`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    await f.close()
  }
})
