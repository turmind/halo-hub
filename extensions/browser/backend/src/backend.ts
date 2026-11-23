import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { WebSocket, WebSocketServer } from 'ws'
import type { ExtensionCaller, ExtensionSessionCaller, ExtensionBackendHostMessage } from '../../contracts/halo-core/extension-notices.js'
import { BROWSER_LIMITS, isReadCommand, type BrowserCommandRequest, type BrowserCommandResponse, type BrowserOperation, type BrowserServerFrame, type BrowserViewerFrame } from './protocol.js'
import { WorkspaceBrowser, type Viewer } from './workspace.js'
import { createBrowserLauncher, type BrowserLauncher } from './browser-launcher.js'
import { Hooks, type IpcSend } from './hooks.js'
import { BrowserFault, checkSignal, publicError } from './errors.js'
import { callerFrom, commandFrom, opaque } from './validation.js'
import type { SigninServiceFactory } from './signin-service.js'
import { privateDirectory } from './profile-store.js'
import { siteScope } from './signin-import/site-scope.js'

interface Operation {
  caller: ExtensionSessionCaller; hash: string; controller: AbortController; operation: BrowserOperation
  response: Promise<BrowserCommandResponse>; expires: number; workspace: WorkspaceBrowser; epoch: number; importScope?: string; resolvedImportScope?: string; notified?: boolean; wake?: () => void
}
export interface BackendOptions {
  dataDir: string
  send: IpcSend
  launch?: BrowserLauncher
  signin?: SigninServiceFactory
  /** Injectable deadlines for manufactured fixtures; production uses protocol constants. */
  commandTimeoutMs?: number
}
export class BrowserBackend {
  readonly hooks: Hooks
  readonly server = createServer((req, res) => { void this.http(req, res) })
  private wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 32768 })
  private workspaces = new Map<string, WorkspaceBrowser>()
  private operations = new Map<string, Operation>()
  private closed = false
  private completionLife = new AbortController()
  private expiryTimer?: ReturnType<typeof setTimeout>
  private launch: BrowserLauncher
  private connections = new Set<import('node:net').Socket>()

  constructor(private options: BackendOptions) {
    this.hooks = new Hooks(options.send); this.launch = options.launch ?? createBrowserLauncher(options.dataDir)
    this.hooks.on('caller', (message: ExtensionBackendHostMessage) => {
      if (message.type === 'halo:caller:updated') for (const workspace of this.workspaces.values()) workspace.updateMarker(message.bindingId, message.userTurnId)
      if (message.type === 'halo:caller:revoked') {
        for (const operation of this.operations.values()) if (operation.caller.bindingId === message.bindingId) operation.controller.abort()
        for (const workspace of this.workspaces.values()) if (workspace.owner?.bindingId === message.bindingId) void this.remove(workspace)
      }
    })
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000
    this.server.on('connection', socket => { this.connections.add(socket); socket.on('close', () => this.connections.delete(socket)) })
    this.server.on('upgrade', (req, socket, head) => {
      try {
        const caller = callerFrom(req.headers); const url = new URL(req.url ?? '/', 'http://private')
        const workspace = this.workspaces.get(caller.projectId)
        if (caller.kind !== 'admin' || url.pathname !== '/stream' || !workspace || workspace.viewId !== url.searchParams.get('viewId')) throw new BrowserFault('forbidden')
        this.wss.handleUpgrade(req, socket, head, ws => this.connect(ws, caller, workspace))
      } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') }
    })
  }
  async listen(socket: string) {
    await privateDirectory(this.options.dataDir)
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(socket, () => { this.server.removeListener('error', reject); resolve() }) })
    if (process.platform !== 'win32') await chmod(socket, 0o600)
    this.options.send({ type: 'ready' }) // No browser launch, download or OS prompt on ready path.
  }
  receive(message: ExtensionBackendHostMessage) { this.hooks.receive(message) }
  private workspace(caller: ExtensionCaller) {
    if (this.closed) throw new BrowserFault('unavailable')
    let workspace = this.workspaces.get(caller.projectId)
    if (!workspace) {
      if (this.workspaces.size >= 32) throw new BrowserFault('unavailable')
      workspace = new WorkspaceBrowser(caller.projectId, this.options.dataDir, this.launch, this.hooks, () => this.busy(), () => { void this.remove(workspace!) })
      this.workspaces.set(caller.projectId, workspace)
    }
    return workspace
  }
  private busy() { this.hooks.setBusy([...this.workspaces.values()].some(workspace => workspace.busy)) }
  private removals = new Map<WorkspaceBrowser, Promise<void>>()
  private remove(workspace: WorkspaceBrowser): Promise<void> {
    const pending = this.removals.get(workspace)
    if (pending) return pending
    const task = (async () => {
      for (const operation of this.operations.values()) if (operation.workspace === workspace) operation.controller.abort()
      await workspace.close()
      if (this.workspaces.get(workspace.projectId) === workspace) this.workspaces.delete(workspace.projectId)
      this.busy()
    })().catch(() => { /* Keep the stopping workspace until its context has actually exited. */ }).finally(() => this.removals.delete(workspace))
    this.removals.set(workspace, task)
    return task
  }
  private connect(ws: WebSocket, caller: ExtensionCaller, workspace: WorkspaceBrowser) {
    const viewer: Viewer = {
      get bufferedAmount() { return ws.bufferedAmount },
      send: data => { if (ws.readyState === WebSocket.OPEN) ws.send(data, error => { if (error) ws.terminate(); else workspace.frameDrained() }) },
      json: (frame: BrowserServerFrame) => { if (ws.readyState === WebSocket.OPEN) { const data = JSON.stringify(frame); if (ws.bufferedAmount + Buffer.byteLength(data) > BROWSER_LIMITS.viewerBufferedBytes) ws.close(1008, 'slow-viewer'); else ws.send(data) } },
      close: () => ws.terminate(),
    }
    workspace.attach(viewer, caller)
    let pending = 0
    const subscribeTimer = setTimeout(() => ws.close(1008, 'subscribe-required'), 10000)
    ws.on('message', (data, binary) => {
      try {
        if (binary || pending >= 64) throw new BrowserFault('invalid-request')
        const frame = JSON.parse(data.toString()) as BrowserViewerFrame
        if (!frame || !['subscribe', 'frame-ack', 'takeover', 'input', 'select-tab', 'visible', 'navigate', 'back', 'forward', 'reload', 'new-tab', 'close-tab'].includes(frame.type)) throw new BrowserFault('invalid-request')
        if (frame.type === 'subscribe') clearTimeout(subscribeTimer)
        pending++
        void workspace.viewerMessage(viewer, frame).catch(error => viewer.json({ type: 'error', error: publicError(error) })).finally(() => { pending-- })
      } catch { ws.close(1008, 'invalid-message') }
    })
    ws.on('error', () => ws.terminate())
    ws.on('close', () => { clearTimeout(subscribeTimer); void workspace.detach(viewer) })
  }
  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []; let length = 0
    for await (const chunk of req) { length += chunk.length; if (length > 32768) throw new BrowserFault('invalid-request'); chunks.push(Buffer.from(chunk)) }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new BrowserFault('invalid-request') }
  }
  private json(res: ServerResponse, body: unknown, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body))
  }
  private async http(req: IncomingMessage, res: ServerResponse) {
    try {
      const caller = callerFrom(req.headers); const url = new URL(req.url ?? '/', 'http://private')
      if (req.method === 'GET' && url.pathname === '/status') {
        const workspace = this.workspace(caller)
        if (caller.kind === 'session' && workspace.acquire(caller, true) === 'busy') {
          this.json(res, { status: 'busy', ownerSessionId: workspace.owner!.sessionId }); return
        }
        this.json(res, workspace.runtime); return
      }
      if (req.method === 'POST' && url.pathname === '/view') {
        if (caller.kind !== 'admin') throw new BrowserFault('forbidden')
        const body = await this.body(req) as { viewId?: string }
        if (!body || typeof body !== 'object' || body.viewId !== undefined && !opaque(body.viewId)) throw new BrowserFault('invalid-request')
        const workspace = this.workspace(caller)
        // Persisted Canvas IDs are routing hints only; fresh backend returns its current ID.
        workspace.touch(); this.json(res, { viewId: workspace.viewId, state: workspace.state() }); return
      }
      if (req.method === 'POST' && url.pathname === '/command') {
        if (caller.kind !== 'session') throw new BrowserFault('forbidden')
        const request = commandFrom(await this.body(req))
        this.json(res, await this.command(caller, request)); return
      }
      const operationId = url.pathname.match(/^\/operations\/([A-Za-z0-9_-]{1,128})$/)?.[1]
      if (req.method === 'GET' && operationId) {
        const candidates = [...this.operations.values()].filter(entry => entry.operation.id === operationId && entry.caller.projectId === caller.projectId && entry.caller.sessionId === caller.sessionId)
        const operation = candidates[0]
        if (!operation || operation.expires < Date.now()) throw new BrowserFault('not-found')
        const command = operation.operation.status === 'completed' ? operation.operation.response.op : operation.operation.op
        if (operation.workspace.driver === 'user' && command !== 'signin-import' && !isReadCommand(command)) throw new BrowserFault('forbidden')
        if (caller.kind === 'session' && command === 'signin-import' && operation.operation.status === 'completed' && caller.userTurnId === operation.caller.userTurnId && operation.workspace.driver === 'user') throw new BrowserFault('forbidden')
        this.json(res, operation.operation); return
      }
      const artifactId = url.pathname.match(/^\/artifacts\/([A-Za-z0-9_-]{1,128})$/)?.[1]
      if (req.method === 'GET' && artifactId) {
        if (caller.kind !== 'session') throw new BrowserFault('forbidden')
        const workspace = this.workspaces.get(caller.projectId)
        if (!workspace) throw new BrowserFault('not-found')
        const data = await workspace.artifact(caller, artifactId)
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(data); return
      }
      throw new BrowserFault('not-found')
    } catch (error) {
      const result = publicError(error)
      this.json(res, { error: result }, result.code === 'unauthorized' ? 401 : result.code === 'forbidden' ? 403 : result.code === 'not-found' ? 404 : result.code === 'invalid-request' ? 400 : 503)
    }
  }
  private operationKey(caller: ExtensionSessionCaller, id: string) { return JSON.stringify([caller.projectId, caller.sessionId, id]) }
  async command(caller: ExtensionSessionCaller, request: BrowserCommandRequest): Promise<BrowserCommandResponse> {
    const previous = this.workspaces.get(caller.projectId)
    if (previous) {
      const removal = this.removals.get(previous)
      if (removal) await removal
      else if (previous.stopping) await this.remove(previous)
      if (this.workspaces.get(caller.projectId) === previous && previous.stopping) throw new BrowserFault('unavailable')
    }
    const workspace = this.workspace(caller)
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const key = this.operationKey(caller, request.id)
    const existing = this.operations.get(key)
    if (existing && existing.hash !== hash) throw new BrowserFault('invalid-request')
    let importScope: string | undefined
    let scope: ReturnType<typeof siteScope> | undefined
    if (request.op === 'signin-import') {
      try { scope = siteScope(request.args.site); importScope = JSON.stringify([scope.host, scope.exact, request.args.from ?? null]) }
      catch { throw new BrowserFault('invalid-request') }
      const prior = [...this.operations.values()].find(entry => entry.workspace === workspace && entry.caller.sessionId === caller.sessionId && (entry.importScope === importScope || entry.resolvedImportScope === importScope) && entry.expires > Date.now())
      if (prior) {
        if (prior.operation.status === 'completed' && caller.userTurnId === prior.caller.userTurnId && workspace.driver === 'user') return { id: prior.operation.id, op: 'signin-import', ok: true, result: { status: 'waiting-for-user' } }
        return this.wait(prior, { ...request, id: prior.operation.id })
      }
    }
    const blocked = workspace.acquire(caller, isReadCommand(request.op))
    if (blocked === 'busy') return { id: request.id, op: request.op, ok: false, status: 'busy', ownerSessionId: workspace.owner!.sessionId }
    if (blocked === 'waiting-for-user') return { id: request.id, op: request.op, ok: false, status: 'waiting-for-user' }
    if (existing) return this.wait(existing, request)
    if (this.operations.size >= 1024 || workspace.running >= 16) throw new BrowserFault('unavailable')
    const controller = new AbortController()
    const abort = () => controller.abort()
    workspace.life.signal.addEventListener('abort', abort, { once: true })
    const operation: Operation = { caller, hash, controller, workspace, epoch: workspace.revision, importScope, operation: { id: request.id, op: request.op, status: 'running' }, response: Promise.resolve({ id: request.id, op: request.op, ok: true, status: 'running' }), expires: Date.now() + BROWSER_LIMITS.handoffTimeoutMs }
    this.operations.set(key, operation); this.scheduleExpiry()
    workspace.activityStarted()
    const deadline = setTimeout(() => { controller.abort(); void this.remove(workspace) }, BROWSER_LIMITS.handoffTimeoutMs)
    operation.response = this.execute(operation, request).then(response => {
      // Terminal non-imports may be explicitly retried with a new request ID after
      // resuming the lease. Keep ID dedupe and successful imports non-replayable.
      if (response.op === 'signin-import' && response.ok && 'result' in response) {
        if (['cancelled', 'unavailable'].includes(response.result.status)) operation.importScope = undefined
        if (response.result.status === 'imported' && scope) operation.resolvedImportScope = JSON.stringify([scope.host, scope.exact, response.result.from.id])
      }
      operation.operation = { id: request.id, status: 'completed', response: response as Exclude<BrowserCommandResponse, { status: 'running' }> }
      workspace.broadcast({ type: 'operation', operation: operation.operation })
      return response
    }).catch(error => {
      const response = { id: request.id, op: request.op, ok: false, error: publicError(error) } as BrowserCommandResponse
      operation.operation = controller.signal.aborted ? { id: request.id, op: request.op, status: 'cancelled' } : { id: request.id, op: request.op, status: 'failed', error: publicError(error) }
      workspace.broadcast({ type: 'operation', operation: operation.operation }); return response
    }).finally(() => {
      clearTimeout(deadline); workspace.life.signal.removeEventListener('abort', abort)
      workspace.running--; workspace.activityEnded()
    })
    return this.wait(operation, request)
  }
  private async execute(operation: Operation, request: BrowserCommandRequest): Promise<BrowserCommandResponse> {
    const { workspace, caller, controller } = operation
    controller.signal.addEventListener('abort', () => operation.wake?.(), { once: true })
    let result
    if (request.op === 'signin-import' || request.op === 'signin-sources') {
      await workspace.inputReleased
      checkSignal(controller.signal)
      if (!workspace.owns(caller) || workspace.driver !== 'agent' || workspace.revision !== operation.epoch) {
        operation.importScope = undefined
        return { id: request.id, op: request.op, ok: false, status: 'waiting-for-user' }
      }
      if (!this.options.signin) {
        if (request.op === 'signin-import') return { id: request.id, op: 'signin-import', ok: true, result: { status: 'unavailable', reason: 'Existing sign-in service is not installed. Sign in inside Browser Canvas.' } }
        throw new BrowserFault('unavailable')
      }
      if (request.op === 'signin-import') { workspace.pendingImport = true; workspace.handoff(caller) }
      let service: ReturnType<SigninServiceFactory> | undefined
      try {
        service = this.options.signin({ caller, signal: controller.signal,
          withCommit: work => workspace.withCommit(caller, controller.signal, work),
          confirm: notice => {
            workspace.pendingImport = true; workspace.handoff(caller)
            operation.operation = { id: request.id, op: request.op, status: 'waiting-for-user' }; workspace.broadcast({ type: 'operation', operation: operation.operation }); operation.wake?.()
            return this.hooks.notice(caller, notice, controller.signal)
          },
        })
        result = request.op === 'signin-sources' ? await service.sources(request.args.site) : await service.import(request.args.site, request.args.from)
        if (request.op === 'signin-sources' && (workspace.revision !== operation.epoch || workspace.driver !== 'agent')) throw new BrowserFault('forbidden')
      } finally { if (request.op === 'signin-import') workspace.pendingImport = false; await service?.dispose() }
    } else {
      if (request.op !== 'handoff') await workspace.ensureContext()
      checkSignal(controller.signal)
      const timeout = setTimeout(() => { controller.abort(); void this.remove(workspace) }, this.options.commandTimeoutMs ?? BROWSER_LIMITS.commandTimeoutMs)
      try { result = await workspace.command(caller, request, controller.signal, operation.epoch) } finally { clearTimeout(timeout) }
    }
    // The importer owns the commit/undo decision, including a commit that wins a late abort.
    if (request.op !== 'signin-import') checkSignal(controller.signal)
    // The discriminant remains request.op; each implementation returns its frozen result DTO.
    return { id: request.id, op: request.op, ok: true, result } as BrowserCommandResponse
  }
  private async wait(operation: Operation, request: BrowserCommandRequest): Promise<BrowserCommandResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const pending = new Promise<BrowserCommandResponse>(resolve => {
      const wake = () => resolve(operation.workspace.runtime.status === 'unavailable'
        ? { id: request.id, op: request.op, ok: false, error: publicError(new BrowserFault('unavailable')) } as BrowserCommandResponse
        : request.op === 'signin-import' && operation.operation.status === 'waiting-for-user'
          ? { id: request.id, op: 'signin-import', ok: true, result: { status: 'waiting-for-user' } }
          : { id: request.id, op: request.op, ok: true, status: 'running' })
      operation.wake = wake
      timer = setTimeout(wake, this.options.commandTimeoutMs ?? BROWSER_LIMITS.commandTimeoutMs)
      if (operation.operation.status === 'waiting-for-user') wake()
    })
    try {
      const response = await Promise.race([operation.response, pending])
      if (!operation.notified && (response.ok && 'status' in response && response.status === 'running' || operation.operation.status === 'waiting-for-user')) {
        operation.notified = true
        void operation.response.then(result => {
          const outcome = result.op === 'signin-import' && result.ok && 'result' in result ? ` Sign-in: ${result.result.status}${result.result.status === 'unavailable' ? ` — ${result.result.reason}` : ''}.` : ''
          // Completion belongs to the caller/operation, not the now-ended workspace lease. Hooks still revoke invalid bindings.
          this.hooks.completed(operation.caller, operation.workspace.viewId, `Browser operation completed (${operation.operation.id}).${outcome} Retrieve its result once with operation ${operation.operation.id} in the same chat.`, this.completionLife.signal)
        })
      }
      return response
    } finally { clearTimeout(timer) }
  }
  private scheduleExpiry() {
    clearTimeout(this.expiryTimer)
    if (!this.operations.size) return
    this.expiryTimer = setTimeout(() => {
      for (const [key, entry] of this.operations) if (entry.expires <= Date.now()) { entry.controller.abort(); this.operations.delete(key) }
      this.scheduleExpiry()
    }, Math.max(1, Math.min(...[...this.operations.values()].map(entry => entry.expires)) - Date.now()))
  }
  async close() {
    if (this.closed) return
    this.closed = true; clearTimeout(this.expiryTimer)
    for (const operation of this.operations.values()) operation.controller.abort()
    await Promise.all([...this.workspaces.values()].map(workspace => workspace.close(3000)))
    // Forced guard invalidation settles import DTOs before sockets/IPC disappear; do not wait on unrelated wedged work.
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.operations.values()].map(operation => operation.response)), new Promise<void>(resolve => { settleTimer = setTimeout(resolve, 250) })]) }
    finally { clearTimeout(settleTimer) }
    this.workspaces.clear(); this.operations.clear(); this.completionLife.abort(); this.hooks.close(); this.hooks.setBusy(false)
    for (const socket of this.connections) socket.destroy()
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}
