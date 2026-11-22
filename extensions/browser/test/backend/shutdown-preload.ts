// Test-only preload for the real index.ts: manufactured source, target and a wedged undo, no production switch.
import { EventEmitter } from 'node:events'
import { mock } from 'node:test'
import type { BrowserContext } from 'playwright'
import { WorkspaceBrowser } from '../../backend/src/workspace.js'
import { ProfileStore } from '../../backend/src/profile-store.js'
import type { ImportCookie } from '../../backend/src/signin-import/types.js'

let workspace: WorkspaceBrowser
let sets = 0
let jar: ImportCookie[] = [{ name: 'fixture', value: 'old', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]
const context = Object.assign(new EventEmitter(), {
  serviceWorkers: () => [], pages: () => [{ workers: () => [] }], route: async () => {}, unroute: async () => {},
  newCDPSession: async () => ({
    async send(method: string, args?: { cookies: ImportCookie[] }) {
      if (method === 'Storage.getCookies') return { cookies: jar.map(cookie => ({ ...cookie, session: true })) }
      if (method === 'Network.setCookies') {
        if (++sets === 2) { process.send?.({ type: 'fixture:cleanup' }); await new Promise(() => {}) }
        jar = structuredClone(args!.cookies)
      }
      return {}
    }, detach: async () => {},
  }),
  close: async () => { (context as unknown as EventEmitter).emit('close') },
}) as unknown as BrowserContext
mock.method(WorkspaceBrowser.prototype, 'ensureContext', async function (this: WorkspaceBrowser) {
  workspace = this
  ;(this as unknown as { context: BrowserContext }).context = context
  return context
})
mock.method(ProfileStore.prototype, 'checkpoint', async () => {
  process.send?.({ type: 'fixture:applied' })
  await new Promise((_, reject) => workspace.life.signal.addEventListener('abort', () => reject(new Error('manufactured abort during checkpoint')), { once: true }))
})
mock.method(ProfileStore.prototype, 'save', async () => true)
const broadcast = WorkspaceBrowser.prototype.broadcast
mock.method(WorkspaceBrowser.prototype, 'broadcast', function (this: WorkspaceBrowser, frame?: Parameters<typeof broadcast>[0]) {
  if (frame?.type === 'operation') process.send?.({ type: 'fixture:operation', operation: frame.operation })
  broadcast.call(this, frame)
})
