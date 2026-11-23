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
    const help = await cli(['--help'], {})
    assert.equal(help.code, 0); assert.match(help.output, /close-tab ID/); assert.doesNotMatch(help.output, /resume/)
    assert.equal((await cli(['resume'], {})).code, 1)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('CLI preserves a pending import id and retrieves its result with one operation request', async () => {
  const paths: string[] = []; let id = ''
  const server = createServer(async (req, res) => {
    paths.push(req.url!)
    res.setHeader('content-type', 'application/json')
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk
      id = JSON.parse(body).id
      res.end(JSON.stringify({ id, op: 'signin-import', ok: true, result: { status: 'waiting-for-user' } }))
    } else res.end(JSON.stringify({ id, status: 'completed', response: { id, op: 'signin-import', ok: true, result: { status: 'cancelled' } } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const env = { HALO_EXT_BACKENDS: JSON.stringify({ browser: { url: `http://127.0.0.1:${address.port}/api/ext/browser`, accessKey: 'manufactured-key', expiresAt: new Date(Date.now() + 60000).toISOString() } }) }
    const pending = await cli(['signin-import', 'example.com'], env)
    assert.equal(pending.code, 0); assert.deepEqual(JSON.parse(pending.output), { status: 'waiting-for-user', id })
    const result = await cli(['operation', id], env)
    assert.equal(result.code, 0); assert.equal(JSON.parse(result.output).response.result.status, 'cancelled')
    assert.deepEqual(paths, ['/api/ext/browser/command', '/api/ext/browser/operations/' + id])
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('CLI close-tab sends the agent command with its tab id', async () => {
  let command: any
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    command = JSON.parse(body); res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, result: { status: 'ok' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const env = { HALO_EXT_BACKENDS: JSON.stringify({ browser: { url: `http://127.0.0.1:${address.port}/api/ext/browser`, accessKey: 'manufactured', expiresAt: new Date(Date.now() + 60000).toISOString() } }) }
    assert.equal((await cli(['close-tab', 'tab-one'], env)).code, 0)
    assert.equal(command.op, 'close-tab'); assert.deepEqual(command.args, { tabId: 'tab-one' })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
