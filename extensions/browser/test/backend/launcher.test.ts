import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, symlink, mkdir, chmod, readdir } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { WorkspaceBrowser } from '../../backend/src/workspace.js'
import { Hooks } from '../../backend/src/hooks.js'
import { publicError } from '../../backend/src/errors.js'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createBrowserLauncher } from '../../backend/src/browser-launcher.js'

test('production Linux launcher uses pinned data-dir revision and never a real browser profile', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-launcher-'))
  try {
    await mkdir(join(directory, 'browsers'))
    // Read-only installed test binary, no download and no real browser profile.
    await symlink(join(homedir(), '.cache/ms-playwright/chromium-1228'), join(directory, 'browsers/chromium-1228'))
    const launch = createBrowserLauncher(directory); const statuses: string[] = []
    const context = await launch(join(directory, 'profile'), new AbortController().signal, info => statuses.push(info.status))
    try { assert.match(context.browser()!.version(), /^149\./); assert.deepEqual(statuses, ['downloading', 'starting']) }
    finally { await context.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const sandbox of [false, true]) test(`production Linux launcher with fresh readonly HOME${sandbox ? ' and bwrap readonly root' : ''}`, { skip: process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() === 0, timeout: 45000 }, async t => {
  if (sandbox && spawnSync('bwrap', ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/true']).status !== 0) { t.skip('bwrap unavailable'); return }
  const directory = await mkdtemp(join(tmpdir(), 'browser-readonly-home-'))
  const home = join(directory, 'home'); const data = join(directory, 'data')
  try {
    await mkdir(home, { mode: 0o555 }); await mkdir(join(data, 'browsers'), { recursive: true })
    await symlink(join(homedir(), '.cache/ms-playwright/chromium-1228'), join(data, 'browsers/chromium-1228'))
    const script = fileURLToPath(new URL('./launcher-home-child.ts', import.meta.url))
    const args = ['--import', 'tsx', script, data, home]
    const child = spawn(sandbox ? 'bwrap' : process.execPath, sandbox
      ? ['--ro-bind', '/', '/', '--tmpfs', '/tmp', '--ro-bind', home, home, '--bind', data, data, '--proc', '/proc', '--dev', '/dev', '--setenv', 'TMPDIR', '/tmp', '--die-with-parent', '--', process.execPath, ...args] : args,
    { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; let errors = ''
    child.stdout.on('data', bytes => { output += bytes.toString() }); child.stderr.on('data', bytes => { errors += bytes.toString() })
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    assert.equal(code, 0, errors); assert.equal(JSON.parse(output).launched, true)
    assert.deepEqual(await readdir(home), [])
    console.log(`[BrowserTest] readonly HOME${sandbox ? ' + bwrap readonly root' : ''}: real Chromium launched; HOME unchanged`)
  } finally { await chmod(home, 0o700); await rm(directory, { recursive: true, force: true }) }
})

for (const [detail, category] of [
  ['error while loading shared libraries: libfixture.so: cannot open shared object file', 'missing-libraries'],
  ['Host system is missing dependencies to run browsers.', 'missing-libraries'],
  ['chrome_crashpad_handler: --database is required\n<process did exit: exitCode=null, signal=SIGTRAP>', 'crashed'],
  ['Timeout 30000ms exceeded.', 'timeout'],
  ['<process did exit: exitCode=1, signal=null>', 'exited'],
  ['manufactured unexpected launch failure', 'unknown'],
]) test(`launch failure maps ${category} without exposing diagnostics`, { skip: process.platform !== 'linux' || process.arch !== 'x64' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-launch-error-'))
  const hooks = new Hooks(() => {}); const logs: string[] = []
  const workspace = new WorkspaceBrowser('/manufactured', directory, createBrowserLauncher(directory), hooks, () => {}, () => {})
  try {
    await mkdir(join(directory, 'browsers'))
    await symlink(join(homedir(), '.cache/ms-playwright/chromium-1228'), join(directory, 'browsers/chromium-1228'))
    t.mock.method(console, 'error', (line: string) => { logs.push(line) })
    // A build may stage a second Playwright copy in backend/node_modules; mock the launcher's actual resolution.
    const { chromium } = createRequire(new URL('../../backend/src/browser-launcher.ts', import.meta.url))('playwright') as typeof import('playwright')
    t.mock.method(chromium, 'launchPersistentContext', async (...[_profile, options]: Parameters<typeof chromium.launchPersistentContext>) => {
      assert.equal(options?.env?.XDG_CONFIG_HOME, join(directory, 'chromium-xdg/config'))
      assert.equal(options?.env?.XDG_CACHE_HOME, join(directory, 'chromium-xdg/cache'))
      assert.equal(options?.env?.XDG_DATA_HOME, join(directory, 'chromium-xdg/data'))
      assert.equal(options?.env?.HOME, join(directory, 'chromium-xdg/home'))
      throw new Error(`${detail}\n/manufactured/private-path?token=manufactured-secret`)
    })
    await assert.rejects(workspace.ensureContext(), error => {
      assert.equal(publicError(error).code, 'unavailable')
      assert.equal(publicError(error).message, workspace.runtime.reason)
      return true
    })
    assert.ok(workspace.runtime.reason?.startsWith(`Browser failed to start (${category}).`))
    assert.equal(workspace.runtime.reason?.includes('Install the Playwright'), category === 'missing-libraries')
    assert.deepEqual(logs, [`[Browser] ${workspace.runtime.reason}`])
    assert.ok(!JSON.stringify([logs, workspace.runtime]).includes('manufactured'))
  } finally { await workspace.close(); hooks.close(); await rm(directory, { recursive: true, force: true }) }
})
