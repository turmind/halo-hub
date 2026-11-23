import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { chmod, readdir } from 'node:fs/promises'
import { chromium, type BrowserContext } from 'playwright'
import { BrowserBackend } from '../backend.js'
import { signinFactory } from './index.js'
import { home, canary } from './fixtures.js'
import { session, http, fixtureLauncher } from '../../../test/backend/fixtures.js'
import type { ExtensionNoticeBackendMessage } from '../../../contracts/halo-core/extension-notices.js'

// Real D backend, real Chromium source/target, real private HTTP/IPC. All cookies manufactured.
test('manufactured Linux import through BrowserBackend, scoped attributes, checkpoint and full restart restore', { timeout: 60000 }, async () => {
  const f = await home()
  let source: BrowserContext | undefined; let backend: BrowserBackend | undefined
  const site = createServer((req, res) => {
    if (req.url === '/seed') res.setHeader('Set-Cookie', [`persist=${canary}; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax`, `session=${canary}; Path=/; HttpOnly; SameSite=Strict`])
    res.setHeader('Content-Type', 'text/html')
    const cookie = req.headers.cookie || ''
    res.end(`<h1>${cookie.includes('persist=' + canary) && cookie.includes('session=' + canary) ? 'fixture-authenticated' : 'fixture-anonymous'}</h1>`)
  })
  const messages: unknown[] = []; const contexts: BrowserContext[] = []
  const pending: ExtensionNoticeBackendMessage[] = []
  let completed: () => void = () => {}
  const completion = new Promise<void>(resolve => { completed = resolve })
  try {
    await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
    const address = site.address(); assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    source = await chromium.launchPersistentContext(join(f.dir, '.config/chromium'), { executablePath: chromium.executablePath(), headless: true, args: ['--password-store=basic', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] })
    await source.pages()[0].goto(origin + '/seed')
    await source.addCookies([{ name: 'unrelated-source', value: canary, domain: 'elsewhere.example', path: '/', expires: Date.now() / 1000 + 86400, secure: true, sameSite: 'Lax' }])
    const cdp = await source.newCDPSession(source.pages()[0])
    await cdp.send('Network.setCookies', { cookies: [false, true].map(hasCrossSiteAncestor => ({ name: 'partition-' + hasCrossSiteAncestor, value: canary, domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'None' as const, partitionKey: { topLevelSite: 'https://example.com', hasCrossSiteAncestor } })) })
    await cdp.detach()
    await source.close(); source = undefined
    const sourceFile = join(f.dir, '.config/chromium/Default/Cookies')
    // Chromium version on this fixture stores Cookies at Default/Cookies; source is read-only.
    await chmod(sourceFile, 0o400)
    const dataDir = join(f.dir, 'data'); const socket = join(f.dir, 'backend.sock')
    const makeBackend = () => new BrowserBackend({ dataDir, signin: signinFactory(f.machine), launch: async (...args) => { const context = await fixtureLauncher(...args); contexts.push(context); return context }, send: message => {
      messages.push(message)
      if (message.type === 'halo:notice' && message.notice.confirmation) pending.push(message)
      if (message.type === 'halo:notice' && message.notice.message.startsWith('Browser operation completed')) completed()
    } })
    backend = makeBackend(); await backend.listen(socket)
    const a = session('one', '/manufactured/signin')
    await http(socket, a, '/command', { id: 'open', op: 'open', args: { url: origin } })
    await contexts[0].addCookies([{ name: 'unrelated-target', value: 'manufactured-target', domain: 'other.example', path: '/', secure: true, sameSite: 'Strict' }])
    const listed = await http(socket, a, '/command', { id: 'sources', op: 'signin-sources', args: { site: origin } })
    assert.equal(listed.body.ok, true); assert.equal(listed.body.result.length, 1); assert.equal(listed.body.result[0].count, 4)
    const waiting = await http(socket, a, '/command', { id: 'import', op: 'signin-import', args: { site: origin, from: listed.body.result[0].id } })
    assert.equal(waiting.body.result.status, 'waiting-for-user'); assert.equal(pending.length, 1)
    assert.equal((await contexts[0].cookies(origin)).length, 0)
    const notice = pending[0]; assert.equal(notice.type, 'halo:notice'); if (notice.type !== 'halo:notice') return
    backend.receive({ type: 'halo:notice:accepted', requestId: notice.requestId, id: notice.notice.id, generation: 'fixture-generation', expiresAt: new Date(Date.now() + 60000).toISOString() })
    backend.receive({ type: 'halo:notice:result', id: notice.notice.id, generation: 'fixture-generation', decision: 'confirm' })
    // Wait for D's pushed completion notice, not polling an operation endpoint.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture completion did not arrive')), 15000)
      void completion.then(() => { clearTimeout(timer); resolve() })
    })
    const newer = session('one', a.projectId, 'turn2')
    const result = await http(socket, newer, '/operations/import')
    assert.equal(result.body.status, 'completed'); assert.equal(result.body.response.result.status, 'imported'); assert.equal(result.body.response.result.count, 4)
    const cookies = await contexts[0].cookies()
    assert.ok(cookies.some(c => c.name === 'unrelated-target')); assert.ok(!cookies.some(c => c.name === 'unrelated-source'))
    assert.equal(cookies.find(c => c.name === 'session')?.expires, -1); assert.equal(cookies.find(c => c.name === 'session')?.sameSite, 'Strict')
    assert.equal(JSON.stringify([messages, listed.body, result.body]).includes(canary), false)
    assert.equal((await http(socket, newer, '/command', { id: 'continue', op: 'scroll', args: { dx: 0, dy: 1 } })).body.result.status, 'ok')
    await backend.close(); backend = undefined
    assert.equal((await readdir(join(dataDir, 'workspaces'))).length, 1)
    backend = makeBackend(); await backend.listen(socket)
    await http(socket, newer, '/command', { id: 'reopen', op: 'open', args: { url: origin + '/check' } })
    const read = await http(socket, newer, '/command', { id: 'read', op: 'read', args: {} })
    assert.match(read.body.result.text, /fixture-authenticated/)
    const restored = contexts[contexts.length - 1]
    assert.equal((await restored.cookies(origin)).find(c => c.name === 'session')?.expires, -1)
    const restoredCdp = await restored.newCDPSession(restored.pages()[0])
    const partitions = (await restoredCdp.send('Storage.getCookies')).cookies.filter(c => c.name.startsWith('partition-'))
    assert.deepEqual(partitions.map(c => c.partitionKey?.hasCrossSiteAncestor).sort(), [false, true])
    assert.ok(partitions.every(c => c.session && c.domain === '127.0.0.1' && c.secure && c.httpOnly))
    await restoredCdp.detach()
  } finally {
    await source?.close(); await backend?.close(); site.closeAllConnections()
    await new Promise<void>(resolve => site.close(() => resolve())); await f.close()
  }
})
