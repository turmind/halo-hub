import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdir, writeFile, symlink, chmod } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { siteScope, matches } from './site-scope.js'
import { discover, browserRoots } from './discovery.js'
import { readStore } from './store-reader.js'
import { signinFactory } from './index.js'
import { metadata } from './cookies.js'
import { home, chromiumStore, host, canary } from './fixtures.js'
import { SigninFault } from './types.js'

const signal = new AbortController().signal
for (const invalid of ['com', 'co.uk', 'github.io', '*.example.com', 'https://a:b@example.com', 'file:///fixture', 'https://bad_host.com', 'https://example.com\\@else.com']) test('reject scope ' + invalid, () => assert.throws(() => siteScope(invalid), SigninFault))
test('scope preserves explicit host, IDNA, dot boundary and IP/localhost exactness', () => {
  assert.deepEqual(siteScope(' HTTPS://BÜCHER.DE.:443/path '), { host: 'xn--bcher-kva.de', exact: false })
  const scope = siteScope('www.example.com'); assert.equal(matches('example.com', scope), false); assert.equal(matches('.a.www.example.com', scope), true)
  for (const host of ['badexample.com', 'example.com.evil', 'other.com']) assert.equal(matches(host, siteScope('example.com')), false)
  for (const host of ['127.0.0.1', '[::1]', 'localhost']) assert.equal(siteScope(host).exact, true)
})
test('metadata discovery does not select absent name/value/encrypted columns and returns no OS secrets', async () => {
  const f = await home(); let tools = 0
  try {
    await chromiumStore(join(f.dir, '.config/chromium'), 'Default', { metadataOnly: true })
    const service = signinFactory(f.machine, async () => { tools++; throw new Error(canary) })(host())
    const sources = await service.sources('example.com')
    assert.equal(sources.length, 1); assert.equal(sources[0].count, 1); assert.equal(sources[0].available, true); assert.equal(tools, 0)
    assert.equal(JSON.stringify(sources).includes(canary), false); await service.dispose()
  } finally { await f.close() }
})
test('read-only worker sees live WAL and filters parents/lookalikes/expired rows', async () => {
  const f = await home()
  try {
    const source = await chromiumStore(join(f.dir, '.config/chromium'))
    const writer = new DatabaseSync(source.file); writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
    try {
      for (const name of ['sub.example.com', '.example.com', 'badexample.com', 'example.com.evil']) writer.prepare('INSERT INTO cookies SELECT ?,path,expires_utc,is_persistent,is_secure,is_httponly,samesite,top_frame_site_key,has_cross_site_ancestor,source_scheme,source_port,name,value,encrypted_value FROM cookies LIMIT 1').run(name)
      const result = await readStore(source, siteScope('example.com'), false, signal)
      assert.equal(result.rows.length, 3); assert.equal(result.rows.every(row => !('value' in row) && !('encrypted' in row) && !('name' in row)), true)
    } finally { writer.close() }
    await chmod(source.file, 0o400)
    assert.equal((await readStore(source, siteScope('example.com'), false, signal)).rows.length, 3)
  } finally { await f.close() }
})
test('standard multi-profile/channel roots and redirected profile guard', async () => {
  const f = await home()
  try {
    const root = join(f.dir, '.config/chromium')
    await chromiumStore(root); await chromiumStore(root, 'Profile 2')
    await chromiumStore(join(f.dir, '.config/google-chrome-beta'))
    await chromiumStore(join(f.dir, 'outside'), 'Custom')
    await symlink(join(f.dir, 'outside/Custom'), join(root, 'Redirect'))
    const sources = await discover(f.machine)
    assert.equal(sources.filter(s => !s.unavailable).length, 3)
    assert.equal(sources.some(s => s.profile === 'Custom'), false)
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const roots = await browserRoots({ ...f.machine, platform })
      for (const name of ['Chrome', 'Edge', 'Brave', 'Chromium', 'Vivaldi', 'Opera']) assert.ok(roots.some(r => r.browser === name), `${platform}:${name}`)
    }
  } finally { await f.close() }
})
test('Windows app-bound marker refuses before OS tool or confirmation', async () => {
  const f = await home('win32'); let calls = 0
  try {
    const root = join(f.machine.env.LOCALAPPDATA!, 'Google/Chrome/User Data')
    await chromiumStore(root); await writeFile(join(root, 'Local State'), JSON.stringify({ os_crypt: { app_bound_encrypted_key: 'manufactured-marker' } }))
    const service = signinFactory(f.machine, async () => { calls++; throw new Error(canary) })(host(async () => { calls++; return 'confirm' }))
    const sources = await service.sources('example.com'); assert.equal(sources[0].available, false); assert.match(sources[0].reason, /app-bound/)
    assert.equal((await service.import('example.com', sources[0].id)).status, 'unavailable'); assert.equal(calls, 0); await service.dispose()
  } finally { await f.close() }
})
test('Firefox standard profile unpartitioned mapping; containers refuse whole source', async () => {
  const f = await home()
  try {
    const root = join(f.dir, '.mozilla/firefox'); const profile = join(root, 'Profiles/fixture'); await mkdir(profile, { recursive: true })
    await writeFile(join(root, 'profiles.ini'), '[Profile0]\nName=Fixture\nIsRelative=1\nPath=Profiles/fixture\n')
    const db = new DatabaseSync(join(profile, 'cookies.sqlite'))
    db.exec("PRAGMA user_version=16; CREATE TABLE moz_cookies(host TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT,name TEXT,value TEXT); CREATE INDEX host_idx ON moz_cookies(host);")
    db.prepare('INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?,?,?)').run('example.com', '/', Math.floor(Date.now() / 1000) + 86400, 1, 1, 2, '', 'fixture', canary)
    const [source] = await discover(f.machine); const result = await readStore(source, siteScope('example.com'), false, signal)
    assert.equal(metadata(result.rows[0], source, siteScope('example.com')).sameSite, 'Strict')
    db.exec("UPDATE moz_cookies SET originAttributes='^userContextId=2'"); db.close()
    const service = signinFactory(f.machine)(host()); assert.equal((await service.sources('example.com'))[0].available, false); await service.dispose()
  } finally { await f.close() }
})
