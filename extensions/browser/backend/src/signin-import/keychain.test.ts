import assert from 'node:assert/strict'
import { test } from 'node:test'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { OsSecrets, runTool } from './os-secrets.js'
import { reasons, type Source } from './types.js'

for (const code of [51, 128, 44, 1]) test(`macOS security exit ${code} preserves the correct key reason`, async t => {
  const source: Source = { id: 'fixture', browser: 'Chrome', profile: 'Default', root: '/unused', file: '/unused/Cookies', family: 'chromium', account: 'Chrome', service: 'Chrome Safe Storage' }
  t.mock.method(childProcess, 'spawn', ((file: string) => {
    assert.equal(file, '/usr/bin/security')
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
    setImmediate(() => { child.stderr.emit('data', Buffer.from('manufactured private OS error')); child.emit('close', code) })
    return child
  }) as unknown as typeof childProcess.spawn)
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const secrets = new OsSecrets({ platform: 'darwin', home: '/unused', env: {} }, new AbortController().signal, runTool)
  t.after(() => secrets.dispose())
  await secrets.macBatch([source])
  await assert.rejects(secrets.chromiumKey(source, 'v10'), {
    reason: code === 51 || code === 128 ? 'keychain' : 'key',
    message: code === 51 || code === 128 ? reasons.keychain.replace('{service}', 'Chrome Safe Storage') : reasons.key,
  })
})
