import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import childProcess, { spawn } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter, once } from 'node:events'
import type { BrowserContext } from 'playwright'
import { WorkspaceBrowser } from '../../backend/src/workspace.js'
import { Hooks } from '../../backend/src/hooks.js'
import { killContext, killOwnedBrowsers, trackBrowser } from '../../backend/src/lifecycle.js'
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

function windowsCleanup(t: TestContext) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!; const nativeSpawn = spawn
  const calls: string[][] = []; const children: ReturnType<typeof spawn>[] = []; const exits: Promise<unknown>[] = []
  let unrefs = 0
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const mocked = t.mock.method(childProcess, 'spawn', ((file, args, options) => {
    assert.equal(file, 'taskkill'); assert.deepEqual(options, { stdio: 'ignore', detached: true, windowsHide: true })
    calls.push(args as string[])
    const child = nativeSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'ignore', detached: true })
    children.push(child); exits.push(new Promise(resolve => child.once('exit', resolve)))
    const unref = child.unref.bind(child)
    t.mock.method(child, 'unref', () => { unrefs++; unref() })
    return child
  }) as typeof spawn)
  syncBuiltinESMExports()
  t.after(async () => {
    killOwnedBrowsers(); Object.defineProperty(process, 'platform', platform)
    mocked.mock.restore(); syncBuiltinESMExports()
    // Re-ref only after the budget assertion so the test runner can await its own detached fixtures.
    for (const child of children) child.ref()
    await Promise.all(exits)
  })
  return { calls, children, get unrefs() { return unrefs } }
}
async function trackedContext(pid: number) {
  const context = Object.assign(new EventEmitter(), {
    browser: () => ({ newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [{ type: 'browser', id: pid }] }), detach: async () => {} }) }),
    close: async () => { context.emit('close') },
  })
  await trackBrowser(context as unknown as BrowserContext)
  return context as unknown as BrowserContext
}

test('three Windows workspaces meet close budget while detached taskkill children take two seconds', { timeout: 10000 }, async t => {
  const f = windowsCleanup(t); const workspaces: WorkspaceBrowser[] = []
  for (let i = 0; i < 3; i++) {
    const context = await trackedContext(700001 + i)
    const hooks = new Hooks(() => {}); t.after(() => hooks.close())
    const workspace = new WorkspaceBrowser(`/manufactured/${i}`, '/unused-no-io', async () => context, hooks, () => {}, () => {})
    let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve })
    Object.assign(workspace, { context, commit: { context, done, invalidate: () => finish() } })
    workspaces.push(workspace)
  }
  const start = performance.now()
  await Promise.all(workspaces.map(workspace => workspace.close(3000)))
  const elapsed = performance.now() - start
  assert.ok(elapsed >= 2900 && elapsed < 3500, `three Windows closes took ${elapsed.toFixed(0)}ms`)
  assert.equal(f.calls.length, 3); assert.equal(f.unrefs, 3)
  assert.ok(f.children.every(child => child.exitCode === null))
  await Promise.all(workspaces.map(workspace => workspace.close()))
  killOwnedBrowsers(); assert.equal(f.calls.length, 3)
  console.log(`[BrowserTest] three Windows closes ${elapsed.toFixed(0)}ms; taskkill still running independently`)
})

test('Windows context, global and exit cleanup spawn once per owned PID and ignore taskkill errors', async t => {
  const f = windowsCleanup(t)
  const first = await trackedContext(700011); const duplicate = await trackedContext(700011)
  killContext(first); killContext(duplicate); killContext(first)
  const second = await trackedContext(700012)
  killOwnedBrowsers(); killContext(second); killOwnedBrowsers()
  const exitCleanup = process.listeners('exit').find(listener => listener === killOwnedBrowsers)
  assert.ok(exitCleanup); exitCleanup(0)
  assert.deepEqual(f.calls, [['/PID', '700011', '/T', '/F'], ['/PID', '700012', '/T', '/F']])
  assert.equal(f.unrefs, 2)
  assert.doesNotThrow(() => { for (const child of f.children) child.emit('error', new Error('manufactured taskkill exit')) })
})
