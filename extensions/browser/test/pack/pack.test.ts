import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, fork, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { once } from 'node:events'
import { chromiumStore } from '../../backend/src/signin-import/fixtures.js'
import { http, session } from '../backend/fixtures.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const hub = resolve(root, '../..')
const pack = join(hub, 'scripts/pack.mjs')
const manifest = JSON.parse(await readFile(join(root, 'halo-extension.json'), 'utf8'))
async function fixture(t: { after: (fn: () => Promise<void>) => void }, id = 'browser') {
  const temp = await mkdtemp(join(tmpdir(), 'browser-pack-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const ext = join(temp, 'extensions', id)
  await mkdir(join(ext, 'backend/src'), { recursive: true })
  await mkdir(join(ext, 'backend/node_modules/example'), { recursive: true })
  await mkdir(join(ext, 'dist'), { recursive: true })
  await mkdir(join(ext, 'skills/browser'), { recursive: true })
  for (const file of ['index.html', 'icon.svg', 'README.md', 'dist/viewer.js', 'skills/browser/SKILL.md', 'backend/index.cjs', 'backend/src/keep.ts', 'backend/node_modules/example/index.js']) await writeFile(join(ext, file), 'fixture')
  for (const folder of ['src', 'test/viewer', 'contracts/halo-core', '.staging']) { await mkdir(join(ext, folder), { recursive: true }); await writeFile(join(ext, folder, 'exclude.txt'), 'development input') }
  await writeFile(join(ext, 'halo-extension.json'), JSON.stringify({ ...manifest, id }))
  await writeFile(join(ext, 'build.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync('calls', JSON.stringify(process.argv.slice(2))+'\\n');`)
  return { temp, ext, run: (args: string[] = []) => execFileSync(process.execPath, [pack, ext, ...args], { cwd: temp, encoding: 'utf8' }) }
}

async function buildFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const f = await fixture(t)
  // Builds replace shared outputs; isolate pack builds from the concurrently running viewer suite.
  for (const file of ['build.mjs', 'package.json', 'halo-extension.json', 'index.html', 'icon.svg', 'README.md', 'src', 'contracts', 'skills', 'backend/src']) await cp(join(root, file), join(f.ext, file), { recursive: true })
  await symlink(join(root, 'node_modules'), join(f.ext, 'node_modules'), 'dir')
  return f
}

test('explicit browser dispatch, single-platform metadata, source preservation and ZIP allowlist', async t => {
  const f = await fixture(t)
  await mkdir(join(f.ext, 'backend/native'), { recursive: true })
  await writeFile(join(f.ext, 'backend/native/stale-fixture'), 'exclude obsolete outputs')
  f.run(['--platform', 'linux-x64'])
  assert.equal(await readFile(join(f.temp, 'calls'), 'utf8'), '["--platform","linux-x64"]\n')
  assert.equal(await readFile(join(f.ext, 'backend/src/keep.ts'), 'utf8'), 'fixture')
  const zip = join(f.temp, 'dist/browser-1.0.0-linux-x64.zip')
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n')
  assert.ok(names.includes('backend/index.cjs')); assert.ok(names.includes('backend/node_modules/example/index.js'))
  assert.ok(names.includes('skills/browser/SKILL.md')); assert.ok(names.includes('dist/viewer.js'))
  assert.ok(!names.some(name => /^(src|test|contracts|\.staging|backend\/(src|native))\//.test(name) || name === 'build.mjs'))
  const update = JSON.parse(await readFile(join(f.temp, 'dist/browser-1.0.0.update.json'), 'utf8'))
  assert.equal(update.minHalo, '2.4.0'); assert.deepEqual(Object.keys(update.packages), ['linux-x64'])
  assert.equal(update.sha256, createHash('sha256').update(await readFile(zip)).digest('hex'))
  assert.deepEqual(update.packages['linux-x64'], { url: update.url, sha256: update.sha256 })
})

for (const id of ['voice-input', 'htrans']) test(`${id} regression: five unchanged STT builder calls, platform zips and committed minHalo`, async t => {
  const f = await fixture(t, id)
  await mkdir(join(f.temp, 'shared/stt-backend'), { recursive: true })
  const script = join(f.temp, 'shared/stt-backend/build.sh')
  // Fixture builder exercises the actual pack dispatch without downloads or modifying STT source.
  await writeFile(script, '#!/bin/sh\nprintf "%s|%s\\n" "$1" "$2" >> calls\nprintf "%s" "$2" > "$1/backend/index.cjs"\n')
  await chmod(script, 0o755)
  await writeFile(join(f.ext, 'update.json'), JSON.stringify({ minHalo: '2.3.0' }))
  f.run(['--platforms'])
  const platforms = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win-x64']
  assert.equal(await readFile(join(f.temp, 'calls'), 'utf8'), platforms.map(p => `${f.ext}|${p}\n`).join(''))
  const update = JSON.parse(await readFile(join(f.temp, `dist/${id}-1.0.0.update.json`), 'utf8'))
  assert.equal(update.minHalo, '2.3.0'); assert.deepEqual(Object.keys(update.packages), platforms)
  for (const platform of platforms) {
    const zip = join(f.temp, `dist/${id}-1.0.0-${platform}.zip`)
    assert.equal(execFileSync('unzip', ['-p', zip, 'backend/index.cjs'], { encoding: 'utf8' }), platform)
    assert.equal(update.packages[platform].sha256, createHash('sha256').update(await readFile(zip)).digest('hex'))
  }
  // Legacy plain packing does not invoke any builder.
  f.run(); assert.equal((await readFile(join(f.temp, 'calls'), 'utf8')).trim().split('\n').length, 5)
})

test('canvas manifest rules mirror Halo validation and required empty extensions', async t => {
  const f = await fixture(t)
  const check = async (patch: object, expected?: string) => {
    await writeFile(join(f.ext, 'halo-extension.json'), JSON.stringify({ ...manifest, ...patch }))
    const result = spawnSync(process.execPath, [pack, f.ext], { cwd: f.temp, encoding: 'utf8' })
    if (expected) { assert.equal(result.status, 1); assert.ok(result.stderr.includes(expected), result.stderr) }
    else assert.equal(result.status, 0, result.stderr)
  }
  await check({ canvas: {} })
  await check({ canvas: { title: 'Browser', title_zh: '浏览器', icon: 'icon.svg', ignored: true } })
  for (const value of [null, [], 'canvas']) await check({ canvas: value }, 'canvas must be an object')
  for (const value of ['', '/icon.svg', '../icon.svg', '..\\icon.svg', 'icon.jpg']) await check({ canvas: { icon: value } }, 'canvas.icon must be a relative .svg or .png path inside the extension directory')
  await check({ canvas: { icon: 'missing.svg' } }, 'canvas icon not found: missing.svg')
  for (const key of ['title', 'title_zh']) for (const value of ['', ' ', 3, 'x'.repeat(65)]) await check({ canvas: { [key]: value } }, `canvas.${key} must be a non-empty string (≤ 64 chars)`)
  await check({ extensions: null }, 'extensions must be an array (empty is fine with activity, chatbar or canvas)')
  await check({ canvas: undefined }, 'extensions must be a non-empty array')
})

test('real linux build and isolated extracted backend boot without development dependencies', { timeout: 60000 }, async t => {
  const f = await buildFixture(t)
  const before = createHash('sha256').update(await readFile(join(f.ext, 'backend/src/index.ts'))).digest('hex')
  execFileSync(process.execPath, ['build.mjs', '--platform', 'linux-x64'], { cwd: f.ext, stdio: 'pipe' })
  assert.equal(createHash('sha256').update(await readFile(join(f.ext, 'backend/src/index.ts'))).digest('hex'), before)
  f.run()
  const extracted = join(f.temp, 'extracted'); await mkdir(extracted)
  execFileSync('unzip', ['-q', join(f.temp, 'dist/browser-1.0.0.zip'), '-d', extracted])
  await readFile(join(extracted, 'backend/node_modules/playwright/cli.js'))
  await readFile(join(extracted, 'backend/node_modules/playwright-core/browsers.json'))
  const css = await readFile(join(extracted, 'dist/viewer.css'), 'utf8')
  assert.ok(!css.includes('@import')); assert.ok(css.includes('--halo-background'))
  const socket = join(f.temp, 'pack.sock')
  const home = join(f.temp, 'home')
  await chromiumStore(join(home, '.config/chromium'), 'Default', { metadataOnly: true })
  const child = fork(join(extracted, 'backend/index.cjs'), [], { cwd: extracted, execArgv: [], env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming'), NODE_PATH: '', HALO_EXT_SOCKET: socket, HALO_EXT_DATA_DIR: join(f.temp, 'data') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const stderr: Buffer[] = []; child.stderr!.on('data', chunk => stderr.push(chunk))
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit } })
  const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(Buffer.concat(stderr).toString()) })])
  assert.deepEqual(ready[0], { type: 'ready' })
  const status = await new Promise<number>(resolve => {
    const req = request({ socketPath: socket, path: '/status' }, response => { response.resume(); resolve(response.statusCode!) }); req.end()
  })
  assert.equal(status, 401)
  // Exercise the production factory and bundled SQLite worker, not just backend boot.
  const sources = await http(socket, session(), '/command', { id: 'pack-sources', op: 'signin-sources', args: { site: 'example.com' } })
  assert.equal(sources.body.ok, true); assert.equal(sources.body.result.length, 1)
  assert.equal(sources.body.result[0].browser, 'Chromium'); assert.equal(sources.body.result[0].count, 1)
  assert.equal(sources.body.result[0].available, true)
})

test('all cross-platform builds use the same JS driver with no native-output prerequisite', { timeout: 60000 }, async t => {
  const f = await buildFixture(t)
  const before = await readFile(join(f.ext, 'backend/src/index.ts'), 'utf8')
  // A leftover output from the old native plan must not enter the next package.
  await mkdir(join(f.ext, 'backend/native'), { recursive: true })
  await writeFile(join(f.ext, 'backend/native/stale-fixture'), 'not a runtime dependency')
  for (const platform of ['linux-arm64', 'darwin-arm64', 'darwin-x64', 'win-x64']) {
    const result = spawnSync(process.execPath, ['build.mjs', '--platform', platform], { cwd: f.ext, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /OS-tool sign-in/)
    await assert.rejects(readFile(join(f.ext, 'backend/native/stale-fixture')))
    await readFile(join(f.ext, 'backend/node_modules/playwright/cli.js'))
    await readFile(join(f.ext, 'backend/node_modules/playwright-core/lib/coreBundle.js'))
    assert.equal(await readFile(join(f.ext, 'backend/src/index.ts'), 'utf8'), before)
  }
})
