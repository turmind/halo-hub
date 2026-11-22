import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

function cli(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../skills/browser/browser.mjs', import.meta.url)), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.on('exit', code => resolve({ code, output }))
  })
}
test('CLI no credentials in success, HTTP errors, malformed map or unavailable environment', async () => {
  const key = 'manufactured-access-key-canary'; let error = false
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`)
    res.writeHead(error ? 502 : 200, { 'content-type': 'application/json' })
    res.end(error ? 'manufactured-cookie-canary ' + key : JSON.stringify({ ok: true, result: { status: 'ready', reflected: key } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const env = { HALO_EXT_BACKENDS: JSON.stringify({ browser: { url: `http://127.0.0.1:${address.port}/api/ext/browser`, accessKey: key, expiresAt: new Date(Date.now() + 60000).toISOString() } }) }
    const success = await cli(['status'], env); assert.equal(success.code, 0); assert.ok(!success.output.includes(key))
    error = true
    const failure = await cli(['read'], env); assert.equal(failure.code, 1); assert.ok(!failure.output.includes(key)); assert.ok(!failure.output.includes('manufactured-cookie-canary'))
    for (const value of ['', key, '{}']) { const result = await cli(['read'], { HALO_EXT_BACKENDS: value }); assert.equal(result.code, 1); assert.ok(!result.output.includes(key)) }
    assert.equal((await cli(['--help'], {})).code, 0)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
