import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

test('actual Chromium process group stops on immediate parent IPC disconnect', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-disconnect-'))
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./lifecycle-child.ts', import.meta.url)), directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  let pid: number | undefined
  try {
    const [message] = await once(child, 'message') as [{ pid: number }]; pid = message.pid
    const exited = once(child, 'exit'); child.disconnect(); await exited
    let running = true
    for (let i = 0; i < 100 && running; i++) {
      try { const status = await readFile(`/proc/${pid}/stat`, 'utf8'); running = !status.includes(') Z ') } catch { running = false }
      if (running) await sleep(20)
    }
    assert.equal(running, false)
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    if (pid) { try { process.kill(-pid, 'SIGKILL') } catch { /* fixture already closed */ } }
    await rm(directory, { recursive: true, force: true })
  }
})
