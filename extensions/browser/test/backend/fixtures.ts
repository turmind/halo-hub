import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import { chromium, type BrowserContext } from 'playwright'
import type { ExtensionCaller, ExtensionSessionCaller } from '../../contracts/halo-core/extension-notices.js'
import { BrowserBackend } from '../../backend/src/backend.js'
import { trackBrowser } from '../../backend/src/lifecycle.js'
import type { BrowserLauncher } from '../../backend/src/browser-launcher.js'

export const session = (sessionId = 'one', projectId = '/manufactured/workspace', userTurnId = 'turn1'): ExtensionSessionCaller => ({ kind: 'session', bindingId: 'binding-' + sessionId + '-' + userTurnId, sessionId, rootSessionId: sessionId, agentId: 'fixture', projectId, userTurnId })
export const admin = (projectId = '/manufactured/workspace'): ExtensionCaller => ({ kind: 'admin', bindingId: 'viewer', projectId, sessionId: 'one', userTurnId: 'turn1' })
export const fixtureLauncher: BrowserLauncher = async (profile, signal) => {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(), headless: true,
    viewport: { width: 1280, height: 800 }, args: ['--password-store=basic', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  })
  await trackBrowser(context)
  if (signal.aborted) { await context.close(); throw new Error('cancelled') }
  return context
}
export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'halo-browser-test-'))
  const site = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    if (req.url === '/seed') res.setHeader('Set-Cookie', ['persistent=manufactured-persistent; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax', 'session=manufactured-session; Path=/; HttpOnly; SameSite=Strict'])
    if (req.url === '/logout') res.setHeader('Set-Cookie', ['persistent=; Max-Age=0; Path=/', 'session=; Max-Age=0; Path=/'])
    if (req.url === '/check') { res.end((req.headers.cookie?.includes('session=manufactured-session') ? 'session-restored' : 'no-session') + (req.headers.cookie?.includes('persistent=manufactured-persistent') ? ' persistent-restored' : ' no-persistent')); return }
    res.end('<title>Manufactured fixture</title><h1>Fixture</h1><button onclick="this.textContent=\'Clicked\'">Click me</button><input aria-label="Message"><a href="/next">Next</a><div style="height:2000px">Scroll</div>')
  })
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
  const address = site.address(); if (!address || typeof address === 'string') throw new Error()
  const origin = `http://127.0.0.1:${address.port}`
  const socket = join(directory, 'backend.sock'); const messages: unknown[] = []
  const contexts: BrowserContext[] = []
  const backend = new BrowserBackend({ dataDir: join(directory, 'data'), send: message => messages.push(message), launch: async (...args) => { const context = await fixtureLauncher(...args); contexts.push(context); return context }, signin: () => ({ sources: async () => [], import: async () => ({ status: 'unavailable', reason: 'Manufactured service unavailable.' }), dispose: async () => {} }) })
  await backend.listen(socket)
  return { backend, directory, socket, origin, messages, contexts, close: async () => { await backend.close(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve())); await rm(directory, { recursive: true, force: true }) } }
}
export async function http(socket: string, caller: ExtensionCaller | null, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method: body === undefined ? 'GET' : 'POST', headers: { ...(caller ? { 'x-halo-caller': Buffer.from(JSON.stringify(caller)).toString('base64url') } : {}), 'content-type': 'application/json' } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const bytes = Buffer.concat(chunks)
        resolve({ status: res.statusCode!, body: res.headers['content-type'] === 'image/png' ? bytes : JSON.parse(bytes.toString()) })
      })
    })
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
