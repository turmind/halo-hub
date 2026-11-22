import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createCipheriv, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { home, chromiumStore, cbc, canary, host } from './fixtures.js'
import { OsSecrets, unprotect, type ToolRunner } from './os-secrets.js'
import { readStore } from './store-reader.js'
import { siteScope } from './site-scope.js'
import { decodeStore } from './cookies.js'
import { signinFactory } from './index.js'
import { secretService } from './secret-service.js'
const signal = new AbortController().signal

for (const version of [23, 24]) test(`Linux manufactured CBC schema ${version}, exact host hash and session/partition preservation`, async () => {
  const f = await home()
  try {
    const source = await chromiumStore(join(f.dir, '.config/chromium'), 'Default', { version, persistent: false, partition: 'https://example.org', ancestor: 0 })
    const secrets = new OsSecrets(f.machine, signal)
    const store = await readStore(source, siteScope('example.com'), true, signal)
    const [cookie] = await decodeStore(store, source, siteScope('example.com'), f.machine, secrets)
    assert.equal(cookie.value, canary); assert.equal(cookie.expires, undefined); assert.deepEqual(cookie.partitionKey, { topLevelSite: 'https://example.org', hasCrossSiteAncestor: false }); secrets.dispose()
    if (version === 24) {
      const db = new DatabaseSync(source.file); db.prepare('UPDATE cookies SET encrypted_value=?').run(cbc('wrong.example.com', canary)); db.close()
      const invalid = await readStore(source, siteScope('example.com'), true, signal)
      await assert.rejects(decodeStore(invalid, source, siteScope('example.com'), f.machine, new OsSecrets(f.machine, signal)), /faithfully/)
    }
  } finally { await f.close() }
})
test('macOS security requests all launch before any grant, shared profiles dedupe, mixed denial independent', async () => {
  const f = await home('darwin')
  try {
    const sources = await Promise.all(['Chromium', 'Chrome', 'Brave'].map(async name => ({ ...await chromiumStore(join(f.dir, name), 'Default', { encrypted: cbc('example.com', canary, 24, 'key', 1003) }), account: name, service: name + ' Safe Storage' })))
    const started: string[] = []; const grants: Array<() => void> = []
    const runner: ToolRunner = async (file, args) => new Promise((resolve, reject) => { assert.equal(file, '/usr/bin/security'); started.push(args[args.length - 1]); grants.push(() => args.includes('Brave') ? reject(new Error(canary)) : resolve(Buffer.from('key\n'))) })
    const secrets = new OsSecrets(f.machine, signal, runner)
    const batch = secrets.macBatch([...sources, sources[0]])
    assert.deepEqual(started, ['Chromium', 'Chrome', 'Brave']); grants.forEach(resolve => resolve()); await batch
    const data = await readStore(sources[0], siteScope('example.com'), true, signal)
    assert.equal((await decodeStore(data, sources[0], siteScope('example.com'), f.machine, secrets))[0].value, canary)
    await assert.rejects(secrets.chromiumKey(sources[2], 'v10'), /denied/)
    await secrets.macBatch(sources); assert.equal(started.length, 3); secrets.dispose()
  } finally { await f.close() }
})
test('Windows GCM uses PowerShell DPAPI input pipe, no values in argv; legacy DPAPI supported', async () => {
  const f = await home('win32')
  try {
    const key = Buffer.alloc(32, 7); const iv = Buffer.alloc(12, 2)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([Buffer.from('v10'), iv, cipher.update(Buffer.concat([createHash('sha256').update('example.com').digest(), Buffer.from(canary)])), cipher.final(), cipher.getAuthTag()])
    const source = await chromiumStore(join(f.dir, 'Chrome'), 'Default', { encrypted })
    await writeFile(join(source.root, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPIfixture-blob').toString('base64') } }))
    let calls = 0
    const runner: ToolRunner = async (file, args, input) => { calls++; assert.match(file, /powershell.exe$/); assert.equal(args.join(' ').includes(canary), false); assert.equal(Buffer.from(input!.toString(), 'base64').toString(), 'fixture-blob'); return Buffer.from(key.toString('base64')) }
    const secrets = new OsSecrets(f.machine, signal, runner)
    assert.equal((await decodeStore(await readStore(source, siteScope('example.com'), true, signal), source, siteScope('example.com'), f.machine, secrets))[0].value, canary)
    assert.equal(calls, 1); secrets.dispose()
    assert.equal((await unprotect(Buffer.from([1, 0, 0, 0]), f.machine, signal, async () => Buffer.from(Buffer.from(canary).toString('base64')))).toString(), canary)
  } finally { await f.close() }
})
test('unknown and v20 envelopes fail before any secret API, no partial import', async () => {
  const f = await home('win32')
  try {
    for (const tag of ['v20', 'v99']) {
      const source = await chromiumStore(join(f.dir, tag), 'Default', { encrypted: Buffer.from(tag + canary) }); let calls = 0
      const secrets = new OsSecrets(f.machine, signal, async () => { calls++; throw new Error(canary) })
      await assert.rejects(decodeStore(await readStore(source, siteScope('example.com'), true, signal), source, siteScope('example.com'), f.machine, secrets))
      assert.equal(calls, 0); secrets.dispose()
    }
  } finally { await f.close() }
})
test('Linux v11 uses only matching wallet; no basic fallback, absent/unsupported bus refuses', async () => {
  const f = await home()
  try {
    const source = await chromiumStore(join(f.dir, '.config/chromium'), 'Default', { encrypted: cbc('example.com', canary, 24, 'wallet-key', 1, 'v11') })
    let app = ''
    const secrets = new OsSecrets(f.machine, signal, undefined, async application => { app = application; return Buffer.from('wallet-key') })
    assert.equal((await decodeStore(await readStore(source, siteScope('example.com'), true, signal), source, siteScope('example.com'), f.machine, secrets))[0].value, canary)
    assert.equal(app, 'chromium'); secrets.dispose()
    for (const address of ['', 'unix:abstract=fixture', 'tcp:host=example.com', 'unixexec:path=fixture']) await assert.rejects(secretService('chromium', { ...f.machine, env: { DBUS_SESSION_BUS_ADDRESS: address } }, signal), /keyring/)
  } finally { await f.close() }
})
test('consent cancel, duplicate pending operation, source change, redacted OS exceptions', async () => {
  const f = await home(); let confirmations = 0; let finish: (answer: 'cancel') => void = () => {}
  try {
    const source = await chromiumStore(join(f.dir, '.config/chromium'))
    let notified: () => void = () => {}
    const notice = new Promise<void>(resolve => { notified = resolve })
    const service = signinFactory(f.machine)(host(async () => { confirmations++; return new Promise(resolve => { finish = resolve; notified() }) }))
    const one = service.import('example.com', undefined); const two = service.import('example.com', undefined)
    await notice
    finish('cancel'); assert.deepEqual(await one, { status: 'cancelled' }); assert.deepEqual(await two, await one); assert.equal(confirmations, 1); await service.dispose()
    const changed = signinFactory(f.machine)(host(async () => { const db = new DatabaseSync(source.file); db.exec("UPDATE cookies SET path='/changed'"); db.close(); return 'confirm' }))
    const result = await changed.import('example.com', undefined); assert.equal(result.status, 'unavailable'); assert.match('reason' in result ? result.reason : '', /changed/); assert.equal(JSON.stringify(result).includes(canary), false); await changed.dispose()
  } finally { await f.close() }
})
