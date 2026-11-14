import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { WebSocket } from 'ws'
import { STT_MODEL_FILES } from '../src/models.js'

/**
 * Contract for the backend process (src/main.ts) with Halo
 * (packages/server/src/extensions/backend.ts):
 *  - no HALO_EXT_SOCKET → exit 1 (only Halo starts it);
 *  - listening on HALO_EXT_SOCKET → IPC `{type:'ready'}`; models already in
 *    place → no download, no `busy`;
 *  - models missing → the download starts on start and IPC `busy: true`
 *    holds Halo's idle stop; any end state (here: every source failing)
 *    sends `busy: false`;
 *  - SIGTERM → open streams get 1001, the process exits 0.
 * main.ts is bundled the way build.sh ships it (esbuild → cjs, sherpa
 * external — never loaded here: no stream reaches `ready`). A `--require`
 * preload swaps http(s).get for a stub, so no test touches the network.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
let tmp: string
let bundle: string
let preload: string
const children: ChildProcess[] = []

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-main-'))
  bundle = path.join(tmp, 'index.cjs')
  await build({
    entryPoints: [path.join(here, '../src/main.ts')], bundle: true, platform: 'node', format: 'cjs',
    target: 'node22', external: ['sherpa-onnx-node'], outfile: bundle, logLevel: 'silent',
  })
  // STUB_NET=fail: every GET errors at once; hang: never answers (until aborted).
  preload = path.join(tmp, 'stub-net.cjs')
  fs.writeFileSync(preload, `
const { EventEmitter } = require('node:events')
const stub = (u, opts) => {
  process.send?.({ type: 'stub-get', url: String(u) })
  const req = new EventEmitter()
  const fail = (msg) => setImmediate(() => req.emit('error', new Error(msg)))
  if (process.env.STUB_NET === 'fail') fail('stub: offline')
  else opts?.signal?.addEventListener('abort', () => fail('aborted'))
  return req
}
require('node:http').get = stub
require('node:https').get = stub
`)
})

afterAll(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  fs.rmSync(tmp, { recursive: true, force: true })
})

interface Run {
  child: ChildProcess
  messages: Array<{ type: string; [k: string]: unknown }>
  socket: string
  /** Resolves with the first IPC message matching `pred`. */
  next(pred: (m: { type: string; [k: string]: unknown }) => boolean): Promise<{ type: string; [k: string]: unknown }>
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function start(name: string, env: Record<string, string | undefined>): Run {
  const dataDir = path.join(tmp, name)
  fs.mkdirSync(dataDir, { recursive: true })
  const socket = path.join(tmp, `${name}.sock`)
  const child = fork(bundle, [], {
    execArgv: ['--require', preload],
    env: { PATH: process.env.PATH, HALO_EXT_SOCKET: socket, HALO_EXT_DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.push(child)
  const messages: Run['messages'] = []
  const waiters: Array<{ pred: (m: Run['messages'][number]) => boolean; resolve: (m: Run['messages'][number]) => void }> = []
  child.on('message', (m) => {
    const msg = m as Run['messages'][number]
    messages.push(msg)
    for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg) }
  })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return {
    child, messages, socket, exit,
    next(pred) {
      const hit = messages.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve) => waiters.push({ pred, resolve }))
    },
  }
}

/** Every model file at its pinned size (sparse — no disk, no hash on `ready`). */
function placeModels(name: string): void {
  for (const f of STT_MODEL_FILES) {
    const p = path.join(tmp, name, 'models', f.path)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.closeSync(fs.openSync(p, 'w'))
    fs.truncateSync(p, f.size)
  }
}

describe('stt backend process', () => {
  it('without HALO_EXT_SOCKET it exits 1', async () => {
    const run = start('nosock', { HALO_EXT_SOCKET: undefined })
    expect(await run.exit).toEqual({ code: 1, signal: null })
  })

  it('models in place: ready over IPC, no download, no busy', async () => {
    placeModels('ready')
    const run = start('ready', { STUB_NET: 'fail' })
    await run.next((m) => m.type === 'ready')
    // Give a would-be download its turn before asserting it never happened.
    await new Promise((r) => setTimeout(r, 200))
    expect(run.messages.map((m) => m.type)).toEqual(['ready'])
    expect(fs.existsSync(run.socket)).toBe(true)
    run.child.kill('SIGTERM')
    expect(await run.exit).toEqual({ code: 0, signal: null })
  })

  it('models missing: the download starts on start and holds busy until it ends', async () => {
    const run = start('busy', { STUB_NET: 'fail' })
    await run.next((m) => m.type === 'ready')
    await run.next((m) => m.type === 'busy' && m.busy === true)
    // Every source of the first file fails → error state → busy released.
    await run.next((m) => m.type === 'busy' && m.busy === false)
    const gets = run.messages.filter((m) => m.type === 'stub-get').map((m) => m.url as string)
    expect(gets).toEqual(STT_MODEL_FILES[0].sources.map((s) => s.url))
    run.child.kill('SIGTERM')
    expect(await run.exit).toEqual({ code: 0, signal: null })
  })

  it('SIGTERM closes open streams with 1001 and exits 0', async () => {
    const run = start('term', { STUB_NET: 'hang' })
    await run.next((m) => m.type === 'ready')
    const ws = new WebSocket(`ws+unix://${run.socket}:/stream`)
    const frames: Array<{ type: string; state?: string }> = []
    const first = new Promise<void>((resolve) => ws.on('message', (d) => { frames.push(JSON.parse(String(d))); resolve() }))
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
    await first
    expect(frames[0]).toMatchObject({ type: 'model', state: 'downloading' })
    run.child.kill('SIGTERM')
    expect(await closed).toBe(1001)
    expect(await run.exit).toEqual({ code: 0, signal: null })
  })
})
