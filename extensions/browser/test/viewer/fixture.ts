import { readFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { fixture, http, session } from '../backend/fixtures.js'
import { EXTENSION_CALLER_HEADER, EXTENSION_VIEW_CONTEXT_HEADER, EXTENSION_VIEW_CONTEXT_QUERY,
  type ExtensionAdminCaller, type ExtensionCanvasInitFrame, type ExtensionViewContext } from '../../contracts/halo-core/extension-notices.js'

export const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
export async function viewerFixture() {
  const backend = await fixture()
  const routing: ExtensionViewContext = { projectId: '/manufactured/工作区', sessionId: 'one' }
  const init: ExtensionCanvasInitFrame = { haloExt: 1, type: 'init', view: 'canvas', protocol: 1, context: { ...routing, viewId: 'browser' }, capabilities: [],
    theme: 'dark', themeVars: { background: '#152030', foreground: '#eeeeee', primary: '#336699', 'primary-foreground': '#ffffff' }, lang: 'en', platform: 'web' }
  const caller: ExtensionAdminCaller = { kind: 'admin', bindingId: 'viewer-binding', ...routing, userTurnId: 'turn1' }
  const callerHeader = Buffer.from(JSON.stringify(caller)).toString('base64url')
  const sockets = new Set<WebSocket>()
  let connections = 0
  const contexts: ExtensionViewContext[] = []
  const frames: unknown[] = []
  const wsServer = new WebSocketServer({ noServer: true })
  const host = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture')
    if (url.pathname === '/host') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<!doctype html><style>body{margin:0}iframe{position:absolute;inset:0;width:100%;height:100%;border:0}</style>
        <iframe sandbox="allow-scripts allow-same-origin" src="/index.html"></iframe><script>
        window.hostFrames=[]; window.addEventListener('message',e=>{ if(e.source!==document.querySelector('iframe').contentWindow)return;
        window.hostFrames.push(e.data); if(e.data.type==='ready') e.source.postMessage(${JSON.stringify(init)},location.origin) });</script>`)
      return
    }
    if (url.pathname === '/target') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<!doctype html><title>Local input fixture</title><style>body{margin:0;background:rgb(40,80,120);height:2400px}button{position:absolute;left:100px;top:80px;width:160px;height:60px}input{position:absolute;left:100px;top:180px;width:300px;height:50px}#drag{position:absolute;left:100px;top:290px;width:120px;height:70px;background:orange}</style>
      <button onclick="this.textContent='Clicked'">Click me</button><input aria-label="Message"><div id="drag">Drag</div><input id="upload" type="file" hidden><script>
      window.events=[]; for(const k of ['keydown','keyup','pointerdown','pointerup','pointermove','wheel']) document.addEventListener(k,e=>window.events.push({type:e.type,key:e.key,x:e.clientX,y:e.clientY}));
      </script>`)
      return
    }
    if (url.pathname === '/api/ext/browser/view') {
      contexts.push(JSON.parse(Buffer.from(String(req.headers[EXTENSION_VIEW_CONTEXT_HEADER]), 'base64url').toString()))
      const upstream = request({ socketPath: backend.socket, path: '/view', method: 'POST', headers: { [EXTENSION_CALLER_HEADER]: callerHeader, 'content-type': 'application/json' } }, response => {
        res.writeHead(response.statusCode!, response.headers); response.pipe(res)
      })
      upstream.on('error', () => { res.statusCode = 502; res.end() }); req.pipe(upstream); return
    }
    const files: Record<string, string> = { '/index.html': 'text/html', '/dist/viewer.js': 'text/javascript', '/dist/viewer.css': 'text/css' }
    if (!files[url.pathname]) { res.statusCode = 404; res.end(); return }
    res.setHeader('Content-Type', files[url.pathname]); res.end(await readFile(join(root, url.pathname)))
  })
  host.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url!, 'http://fixture')
    contexts.push(JSON.parse(Buffer.from(url.searchParams.get(EXTENSION_VIEW_CONTEXT_QUERY)!, 'base64url').toString()))
    url.searchParams.delete(EXTENSION_VIEW_CONTEXT_QUERY)
    wsServer.handleUpgrade(req, socket, head, viewer => {
      connections++
      const upstream = new WebSocket(`ws+unix://${backend.socket}:/stream${url.search}`, { headers: { [EXTENSION_CALLER_HEADER]: callerHeader } })
      sockets.add(viewer); sockets.add(upstream)
      const pending: string[] = []
      viewer.on('message', data => { frames.push(JSON.parse(data.toString())); if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString()); else pending.push(data.toString()) })
      upstream.on('open', () => { for (const message of pending) upstream.send(message) })
      upstream.on('message', (data, binary) => { if (viewer.readyState === WebSocket.OPEN) viewer.send(data, { binary }) })
      viewer.on('close', () => { sockets.delete(viewer); upstream.close() })
      upstream.on('close', () => { sockets.delete(upstream); viewer.close() })
      upstream.on('error', () => viewer.close())
    })
  })
  await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve))
  const address = host.address(); if (!address || typeof address === 'string') throw new Error('fixture address')
  const origin = `http://127.0.0.1:${address.port}`
  const command = (op: string, args: unknown = {}, turn = 'turn1') => http(backend.socket, session('one', routing.projectId, turn), '/command', { id: crypto.randomUUID(), op, args })
  return { ...backend, browserContexts: backend.contexts, origin, init, contexts, frames, command, get connections() { return connections }, get liveSockets() { return sockets.size },
    breakConnections() { for (const socket of sockets) socket.terminate() },
    close: async () => { for (const socket of sockets) socket.terminate(); wsServer.close(); host.closeAllConnections(); await new Promise<void>(resolve => host.close(() => resolve())); await backend.close() } }
}
