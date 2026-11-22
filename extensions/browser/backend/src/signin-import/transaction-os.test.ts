import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext } from 'playwright'
import { installCookies } from './import-cookies.js'
import { secretService } from './secret-service.js'
import { safariMetadata } from './safari.js'
import { signinFactory } from './index.js'
import { runTool } from './os-secrets.js'
import { home, chromiumStore, canary, host } from './fixtures.js'
import { siteScope } from './site-scope.js'
import { validateCookie } from './cookies.js'
import { appBound } from './discovery.js'
import type { ImportCookie, Source } from './types.js'
const signal = new AbortController().signal

function transactionFixture(fail: boolean | 'rollback' = false) {
  const old = { name: 'fixture', value: 'old', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', sourceScheme: 'Secure', sourcePort: 443, session: true }
  const calls: Array<{ method: string; args: any }> = []; let sets = 0
  const session = { send: async (method: string, args: any) => {
    calls.push({ method, args })
    if (method === 'Storage.getCookies') return { cookies: [old, { ...old, name: 'unrelated' }, { ...old, partitionKey: { topLevelSite: 'https://other.example', hasCrossSiteAncestor: true } }] }
    if (method === 'Network.setCookies' && fail && (++sets === 1 || fail === 'rollback')) throw new Error(canary)
    return {}
  }, detach: async () => {} }
  const context = { serviceWorkers: () => [], pages: () => [{ workers: () => [] }], newCDPSession: async () => session, route: async () => {}, unroute: async () => {} } as unknown as BrowserContext
  return { context, calls, old }
}
test('partial target failure restores affected keys only, no partition-wide delete, resumes scripts', async () => {
  const f = transactionFixture(true)
  const cookies: ImportCookie[] = [{ name: 'fixture', value: canary, domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }, { name: 'new', value: canary, domain: 'example.com', path: '/', secure: true }]
  await assert.rejects(installCookies(f.context, cookies, signal), /were restored/)
  const restores = f.calls.filter(c => c.method === 'Network.setCookies')[1].args.cookies
  assert.equal(restores.length, 2); assert.equal(restores[0].value, 'old'); assert.equal(restores[1].expires, 1)
  assert.ok(!f.calls.some(c => c.method === 'Network.deleteCookies'))
  assert.ok(f.calls.some(c => c.method === 'Emulation.setScriptExecutionDisabled' && c.args.value === false))
})
test('rollback failure says target uncertain, successful no-op skips writes', async () => {
  const failed = transactionFixture('rollback')
  await assert.rejects(installCookies(failed.context, [{ name: 'fixture', value: canary, domain: 'example.com', path: '/', secure: true }], signal), /uncertain/)
  const noOp = transactionFixture()
  assert.equal(await installCookies(noOp.context, [{ name: 'fixture', value: 'old', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }], signal), 1)
  assert.ok(!noOp.calls.some(c => c.method === 'Network.setCookies'))
  const persistent = transactionFixture(); Object.assign(persistent.old, { session: false, expires: Date.now() / 1000 + 86400 })
  await installCookies(persistent.context, [{ name: 'fixture', value: 'old', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }], signal)
  assert.ok(persistent.calls.some(c => c.method === 'Network.setCookies'))
})
test('cookie prefixes and unsupported relaxed attributes are rejected', () => {
  for (const cookie of [{ name: '__Host-key', value: 'fixture', domain: '.example.com', path: '/', secure: true }, { name: '__Secure-key', value: 'fixture', domain: 'example.com', path: '/', secure: false }, { name: 'key', value: 'fixture', domain: 'example.com', path: '/', sameSite: 'None' as const, secure: false }]) assert.throws(() => validateCookie(cookie))
  assert.equal(appBound({ os_crypt: { app_bound_encrypted_key: '' } }), true)
})
test('Secret Service exact application lookup, raw callback tuple and key buffer cleanup', async () => {
  const f = await home(); const methods: string[] = []; let closed = 0
  const key = Buffer.from('manufactured-key')
  try {
    const result = await secretService('chromium', { ...f.machine, env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/manufactured/bus' } }, signal, () => ({
      connection: { stream: { destroy() { closed++ } }, on() {} },
      invoke(message, callback) {
        methods.push(String(message.member))
        if (message.member === 'SearchItems') { assert.deepEqual(message.body, [[['application', 'chromium']]]); callback(null, ['/item'], []) }
        else if (message.member === 'OpenSession') callback(null, ['s', ''], '/session')
        else if (message.member === 'GetSecret') callback(null, ['/session', [], key, 'text/plain'])
        else callback(null)
      },
    }))
    assert.equal(result.toString(), 'manufactured-key'); assert.equal(key.every(b => b === 0), true)
    assert.deepEqual(methods, ['SearchItems', 'OpenSession', 'GetSecret', 'Close']); assert.equal(closed, 1)
    result.fill(0)
  } finally { await f.close() }
})
test('locked Secret Service never silently unlocks or substitutes another key', async () => {
  const f = await home(); const methods: string[] = []
  try {
    await assert.rejects(secretService('chromium', { ...f.machine, env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/manufactured/bus' } }, signal, () => ({ connection: { stream: { destroy() {} }, on() {} }, invoke(message, callback) { methods.push(String(message.member)); callback(null, [], ['/locked']) } })), /keyring/)
    assert.deepEqual(methods, ['SearchItems'])
  } finally { await f.close() }
})
test('OS tool cancellation stops child and returns only allowlisted reason', async () => {
  const controller = new AbortController()
  const result = runTool(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], undefined, controller.signal)
  controller.abort(); await assert.rejects(result, /storage key is unavailable/)
})
test('Safari metadata skips name/value fields and reports non-faithful format unavailable', async () => {
  const f = await home('darwin')
  try {
    const directory = join(f.dir, 'Library/Cookies'); await mkdir(directory, { recursive: true })
    const domain = Buffer.from('example.com\0'); const secret = Buffer.from(canary + '\0')
    const record = Buffer.alloc(56 + domain.length + secret.length * 2 + 2)
    record.writeUInt32LE(record.length, 0); record.writeUInt32LE(56, 16); record.writeUInt32LE(56 + domain.length, 20); record.writeUInt32LE(56 + domain.length + secret.length, 24); record.writeUInt32LE(56 + domain.length + secret.length + 2, 28)
    record.writeDoubleLE(Date.now() / 1000 + 86400 - 978307200, 40); domain.copy(record, 56); secret.copy(record, 56 + domain.length)
    const page = Buffer.alloc(16); page[2] = 1; page.writeUInt32LE(1, 4); page.writeUInt32LE(16, 8)
    const header = Buffer.alloc(12); header.write('cook'); header.writeUInt32BE(1, 4); header.writeUInt32BE(page.length + record.length, 8)
    const file = join(directory, 'Cookies.binarycookies'); await writeFile(file, Buffer.concat([header, page, record]))
    const source: Source = { id: 'fixture', browser: 'Safari', profile: 'Legacy', root: directory, file, family: 'safari' }
    assert.equal((await safariMetadata(source, siteScope('example.com'))).count, 1)
    const service = signinFactory(f.machine)(host()); const sources = await service.sources('example.com')
    assert.equal(sources[0].count, 1); assert.equal(sources[0].available, false); assert.ok(!JSON.stringify(sources).includes(canary)); await service.dispose()
    await writeFile(file, Buffer.from('cookbad')); await assert.rejects(safariMetadata(source, siteScope('example.com')))
  } finally { await f.close() }
})
test('Mac service requires hook-2 confirmation before any batched OS request; dispose cancels', async () => {
  const f = await home('darwin'); let tools = 0
  try {
    await chromiumStore(join(f.dir, 'Library/Application Support/Chromium'))
    const service = signinFactory(f.machine, async () => { tools++; throw new Error(canary) })(host(async () => 'cancel'))
    assert.deepEqual(await service.import('example.com', undefined), { status: 'cancelled' }); assert.equal(tools, 0)
    await service.dispose(); assert.deepEqual(await service.import('example.com', undefined), { status: 'cancelled' })
    let received: () => void = () => {}
    const notice = new Promise<void>(resolve => { received = resolve })
    const abandoned = signinFactory(f.machine)(host(async () => { received(); return new Promise(() => {}) }))
    const waiting = abandoned.import('example.com', undefined)
    await notice; await abandoned.dispose(); assert.deepEqual(await waiting, { status: 'cancelled' })
  } finally { await f.close() }
})
