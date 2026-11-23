import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import fs from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { chromium } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { discover } from './discovery.js'
import { signinFactory } from './index.js'
import { home, chromiumStore, host, cbc, canary } from './fixtures.js'
import { reasons, type SigninHost } from './types.js'

function deny(t: TestContext, operation: 'readFile' | 'realpath' | 'stat' | 'readdir', file: string, active = () => true) {
  const original = fs[operation]
  t.mock.method(fs, operation, (async (...args: any[]) => {
    if (active() && String(args[0]) === file) throw Object.assign(new Error(canary), { code: 'EPERM' })
    return (original as any)(...args)
  }) as any)
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
}
for (const target of ['Preferences', 'cookie-realpath', 'profile-realpath', 'cookie-stat']) test(`macOS ${target} denial after approval belongs to the chosen source`, async t => {
  const f = await home('darwin'); t.after(() => f.close())
  const root = join(f.dir, 'Library/Application Support/Google/Chrome')
  const source = await chromiumStore(root)
  await fs.writeFile(join(root, 'Default/Preferences'), JSON.stringify({ profile: { name: 'Custom account name' } }))
  const before = (await discover(f.machine))[0]
  let denied = false; let tools = 0
  deny(t, target === 'Preferences' ? 'readFile' : target === 'cookie-stat' ? 'stat' : 'realpath', target === 'Preferences' ? join(root, 'Default/Preferences') : target === 'profile-realpath' ? join(root, 'Default') : source.file, () => denied)
  const service = signinFactory(f.machine, async () => { tools++; throw new Error(canary) })(host(async () => { denied = true; return 'confirm' }))
  t.after(() => service.dispose())
  assert.equal((await service.sources('example.com'))[0].profile, 'Custom account name')
  const result = await service.import('example.com', before.id)
  assert.deepEqual(result, { status: 'unavailable', reason: reasons.privacy.replace('{browser}', 'Chrome') })
  const after = (await discover(f.machine)).filter(s => s.browser === 'Chrome')
  assert.equal(after.length, 1); assert.equal(after[0].id, before.id); assert.equal(after[0].unavailable, 'privacy')
  if (target === 'Preferences') assert.equal(after[0].profile, 'Unavailable profile')
  assert.equal(tools, 0)
})
for (const afterApproval of [false, true]) test(`Windows Local State denial ${afterApproval ? 'after approval' : 'at discovery'} marks every source locked`, async t => {
  const f = await home('win32'); t.after(() => f.close())
  const root = join(f.machine.env.LOCALAPPDATA!, 'Google/Chrome/User Data')
  await chromiumStore(root)
  let denied = !afterApproval; let tools = 0; let approvals = 0
  deny(t, 'readFile', join(root, 'Local State'), () => denied)
  const service = signinFactory(f.machine, async () => { tools++; throw new Error(canary) })(host(async () => { approvals++; denied = true; return 'confirm' }))
  t.after(() => service.dispose())
  assert.deepEqual(await service.import('example.com', undefined), { status: 'unavailable', reason: reasons.locked })
  assert.equal(tools, 0); assert.equal(approvals, afterApproval ? 1 : 0)
  await chromiumStore(root, 'Profile 2')
  const sources = await service.sources('example.com')
  assert.equal(sources.length, 2); assert.ok(sources.every(s => !s.available && s.reason === reasons.locked))
  assert.ok(sources.every(s => s.profile !== 'Unavailable profiles'))
})
test('Preferences denial in profile A leaves profile B readable and importable', async t => {
  const f = await home('darwin'); t.after(() => f.close())
  const root = join(f.dir, 'Library/Application Support/Google/Chrome')
  await chromiumStore(root, 'Default')
  await chromiumStore(root, 'Profile 2', { encrypted: cbc('example.com', canary, 24, 'key', 1003) })
  deny(t, 'readFile', join(root, 'Default/Preferences'))
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close())
  const context = await browser.newContext()
  let checkpoints = 0
  const bound: SigninHost = { ...host(async () => 'confirm'), withCommit: work => work({ tabId: () => 'fixture', withContext: task => task(context), cleanup: task => task(context), checkpoint: async () => { checkpoints++ } }) }
  const service = signinFactory(f.machine, async () => Buffer.from('key\n'))(bound); t.after(() => service.dispose())
  const sources = await service.sources('example.com')
  assert.equal(sources.length, 2)
  assert.equal(sources.find(s => s.profile === 'Unavailable profile')?.available, false)
  assert.equal(sources.find(s => s.profile === 'Profile 2')?.available, true)
  const result = await service.import('example.com', undefined)
  assert.equal(result.status, 'imported'); assert.equal(checkpoints, 1)
  assert.ok((await context.cookies('https://example.com')).some(cookie => cookie.value === canary))
})
test('a resolved cookie symlink outside the root remains scope, not a read failure', async t => {
  const f = await home(); t.after(() => f.close())
  const root = join(f.dir, '.config/chromium')
  const outside = await chromiumStore(join(f.dir, 'outside'))
  const file = join(root, 'Default/Network/Cookies')
  await fs.mkdir(dirname(file), { recursive: true }); await fs.symlink(outside.file, file)
  const sources = await discover(f.machine)
  assert.equal(sources.length, 1); assert.equal(sources[0].unavailable, 'scope')
  const service = signinFactory(f.machine)(host()); t.after(() => service.dispose())
  assert.equal((await service.sources('example.com'))[0].reason, reasons.scope)
})
for (const index of ['profiles.ini', 'installs.ini', 'readdir']) for (const populated of [false, true]) test(`Firefox ${index} error ${populated ? 'does not shadow a readable profile' : 'retains a root placeholder'}`, async t => {
  const f = await home('darwin'); t.after(() => f.close())
  const root = join(f.dir, 'Library/Application Support/Firefox')
  await fs.mkdir(root, { recursive: true })
  if (populated) {
    const profile = join(root, 'Profiles/default'); await fs.mkdir(profile, { recursive: true })
    const db = new DatabaseSync(join(profile, 'cookies.sqlite'))
    db.exec("PRAGMA user_version=16; CREATE TABLE moz_cookies(host TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT); INSERT INTO moz_cookies VALUES('example.com','/',4102444800,1,1,2,'')"); db.close()
  }
  deny(t, index === 'readdir' ? 'readdir' : 'readFile', index === 'readdir' ? root : join(root, index))
  const service = signinFactory(f.machine)(host()); t.after(() => service.dispose())
  const sources = await service.sources('example.com')
  assert.equal(sources.length, 1); assert.equal(sources[0].available, populated)
  assert.equal(sources[0].profile, populated ? 'default' : 'Unavailable profiles')
  if (!populated) assert.equal(sources[0].reason, reasons.privacy.replace('{browser}', 'Firefox'))
})
