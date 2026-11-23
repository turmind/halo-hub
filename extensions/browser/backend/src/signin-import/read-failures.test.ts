import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import workerThreads from 'node:worker_threads'
import { fileFingerprint, readStore } from './store-reader.js'
import { readFailure, reasons, type Reason } from './types.js'
import { discover } from './discovery.js'
import { signinFactory } from './index.js'
import { siteScope } from './site-scope.js'
import { home, chromiumStore, host, canary } from './fixtures.js'

const signal = new AbortController().signal
const cases: [NodeJS.Platform, string, Reason][] = [
  ['darwin', 'EPERM', 'privacy'], ['darwin', 'EACCES', 'privacy'],
  ['win32', 'EBUSY', 'locked'], ['win32', 'EPERM', 'locked'], ['win32', 'EACCES', 'locked'],
  ['linux', 'EACCES', 'unreadable'], ['linux', 'EPERM', 'unreadable'], ['darwin', 'EBUSY', 'unreadable'], ['linux', 'EIO', 'unreadable'],
]
for (const [platform, code, reason] of cases) test(`${platform} ${code} is ${reason} for stat and open`, async t => {
  const f = await home(platform); t.after(() => f.close())
  const source = await chromiumStore(join(f.dir, 'fixture'))
  const error = Object.assign(new Error(canary), { code })
  const fault = readFailure(error, platform, 'Chrome')
  assert.equal(fault.reason, reason); assert.ok(!fault.message.includes(canary))
  if (reason === 'privacy') { assert.match(fault.message, /reading Chrome data/); assert.match(fault.message, /Full Disk Access/); assert.match(fault.message, /Cmd\+Q/); assert.doesNotMatch(fault.message, /Close that browser/) }
  const stat = fs.stat
  const statMock = t.mock.method(fs, 'stat', (async (...args: any[]) => { if (args[0] === source.file) throw error; return (stat as any)(...args) }) as typeof fs.stat)
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(fileFingerprint(source, platform), { reason })
  statMock.mock.restore(); syncBuiltinESMExports()
  assert.ok((await fs.stat(source.file)).isFile(), 'stat succeeds while the open probe fails')
  t.mock.method(fs, 'open', async () => { throw error }); syncBuiltinESMExports()
  await assert.rejects(readStore(source, siteScope('example.com'), false, signal, platform), { reason })
})
for (const errcode of [5, 6, 261, 262]) test(`SQLite errcode ${errcode} is locked`, () => {
  assert.equal(readFailure({ errcode }, 'linux', 'Chrome').reason, 'locked')
})
test('other SQLite failures are unreadable', () => {
  for (const errcode of [1, 10, 14]) assert.equal(readFailure({ errcode }, 'darwin', 'Chrome').reason, 'unreadable')
})
test('real SQLite worker reports BUSY as locked and ordinary SQL errors as unreadable', async t => {
  const f = await home(); t.after(() => f.close())
  const source = await chromiumStore(join(f.dir, 'fixture'))
  const writer = new DatabaseSync(source.file)
  try {
    writer.exec('BEGIN EXCLUSIVE')
    await assert.rejects(readStore(source, siteScope('example.com'), false, signal), { reason: 'locked' })
    writer.exec('ROLLBACK; DROP TABLE meta')
    await assert.rejects(readStore(source, siteScope('example.com'), false, signal), { reason: 'unreadable' })
  } finally { writer.close() }
})
test('non-SQLite store stays a format failure', async t => {
  const f = await home(); t.after(() => f.close())
  const source = await chromiumStore(join(f.dir, 'fixture'))
  await fs.writeFile(source.file, 'not a SQLite database')
  await assert.rejects(readStore(source, siteScope('example.com'), false, signal), { reason: 'format' })
})
for (const kind of ['timeout', 'error', 'exit']) test(`worker ${kind} is unreadable, never locked`, async t => {
  const f = await home(); t.after(() => f.close())
  const source = await chromiumStore(join(f.dir, 'fixture'))
  const worker = Object.assign(new EventEmitter(), { stderr: new PassThrough(), terminate: async () => 0 })
  t.mock.method(workerThreads, 'Worker', function () {
    if (kind !== 'timeout') setImmediate(() => worker.emit(kind, kind === 'exit' ? 1 : new Error(canary)))
    return worker
  } as unknown as typeof workerThreads.Worker)
  const schedule = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => schedule(callback, delay === 15000 ? 20 : delay, ...args)) as typeof setTimeout)
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(readStore(source, siteScope('example.com'), false, signal), { reason: 'unreadable', message: reasons.unreadable })
})
for (const operation of ['readdir', 'stat', 'readFile'] as const) test(`macOS discovery ${operation} EPERM keeps an unavailable Chrome source`, async t => {
  const f = await home('darwin'); t.after(() => f.close())
  const root = join(f.dir, 'Library/Application Support/Google/Chrome')
  const source = await chromiumStore(root)
  const original = fs[operation]
  t.mock.method(fs, operation, (async (...args: any[]) => {
    const file = String(args[0])
    if (operation === 'readdir' && file === root || operation === 'stat' && file === source.file || operation === 'readFile' && file === join(root, 'Local State')) throw Object.assign(new Error(canary), { code: 'EPERM' })
    return (original as any)(...args)
  }) as any)
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const sources = await discover(f.machine)
  assert.equal(sources.filter(item => item.browser === 'Chrome' && item.unavailable === 'privacy').length, 1)
  const service = signinFactory(f.machine)(host()); t.after(() => service.dispose())
  const dto = (await service.sources('example.com')).find(item => item.profile === 'Unavailable profiles')!
  assert.equal(dto.available, false); assert.equal(dto.count, null); assert.match(dto.reason, /reading Chrome data/)
  assert.ok(!JSON.stringify(dto).includes(f.dir)); assert.ok(!JSON.stringify(dto).includes(canary))
  assert.deepEqual(await service.import('example.com', dto.id), { status: 'unavailable', reason: dto.reason })
})
test('macOS permission loss after approval reports privacy instead of a missing or changed source', async t => {
  const f = await home('darwin'); t.after(() => f.close())
  const root = join(f.dir, 'Library/Application Support/Google/Chrome')
  await chromiumStore(root)
  const stat = fs.stat; let denied = false
  t.mock.method(fs, 'stat', (async (...args: any[]) => {
    if (denied && String(args[0]).startsWith(root)) throw Object.assign(new Error(canary), { code: 'EPERM' })
    return (stat as any)(...args)
  }) as typeof fs.stat)
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const service = signinFactory(f.machine, async () => { assert.fail('no key request after privacy failure') })(host(async () => { denied = true; return 'confirm' }))
  t.after(() => service.dispose())
  const result = await service.import('example.com', undefined)
  assert.equal(result.status, 'unavailable')
  assert.match('reason' in result ? result.reason : '', /privacy protection blocked reading Chrome/)
})
