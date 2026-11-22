import { createHash, randomUUID } from 'node:crypto'
import { writeFile, rm, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext, CDPSession, ElementHandle, Page } from 'playwright'
import type { ExtensionCaller, ExtensionSessionCaller } from '../../contracts/halo-core/extension-notices.js'
import { BROWSER_LIMITS, BROWSER_VIEWPORT, BROWSER_JPEG_QUALITY, type BrowserCommandRequest, type BrowserCommandResults, type BrowserCommandName, type BrowserState, type BrowserRuntimeInfo, type BrowserServerFrame, type BrowserPageRead, type BrowserViewerFrame } from './protocol.js'
import { BrowserFault, checkSignal, safeUrl } from './errors.js'
import { ProfileStore } from './profile-store.js'
import { FrameDelivery, type FramePeer } from './frame-delivery.js'
import { InputDispatcher, validateInput } from './input.js'
import type { BrowserLauncher } from './browser-launcher.js'
import type { Hooks } from './hooks.js'
import { killContext } from './lifecycle.js'
import type { SigninCommit } from './signin-service.js'

export interface Viewer extends FramePeer { json(frame: BrowserServerFrame): void; close(): void }
interface ViewerState { caller: ExtensionCaller; visible: boolean; subscribed: boolean }
export class WorkspaceBrowser {
  readonly viewId: string
  readonly store: ProfileStore
  readonly life = new AbortController()
  runtime: BrowserRuntimeInfo = { protocol: 1, status: 'starting' }
  owner?: ExtensionSessionCaller
  driver: 'idle' | 'agent' | 'user' = 'idle'
  pendingImport = false
  running = 0
  private fence: string | null = null
  private latestMarkers = new Map<string, string>()
  private epoch = 0
  private context?: BrowserContext
  private initialization?: Promise<BrowserContext>
  private pages = new Map<string, Page>()
  private titles = new Map<Page, string>()
  private activeTabId: string | null = null
  private cdp?: CDPSession
  private input?: InputDispatcher
  private viewers = new Map<Viewer, ViewerState>()
  private inputOwner?: Viewer
  private delivery = new FrameDelivery()
  private tail: Promise<unknown> = Promise.resolve()
  private leaseTimer?: ReturnType<typeof setTimeout>
  private checkpointTimer?: ReturnType<typeof setTimeout>
  private checkpointDirty = false
  private snapshotId = ''
  private refs = new Map<string, ElementHandle>()
  private artifacts = new Map<string, { sessionId: string; expires: number; file: string }>()
  private oversizedFrame = false
  private capturing = false
  private closing = false
  private closeRequested = false
  private commit?: { context: BrowserContext; done: Promise<void>; invalidate: () => void }
  private lastActivity = performance.now()

  constructor(readonly projectId: string, dataDir: string, private launch: BrowserLauncher, readonly hooks: Hooks, private changed: () => void, private expired: () => void) {
    this.store = new ProfileStore(dataDir, projectId)
    this.viewId = createHash('sha256').update('browser-view:' + projectId).digest('hex')
  }
  frameDrained() { this.delivery.retry() }
  get revision() { return this.epoch }
  get hasViewers() { return [...this.viewers.values()].some(view => view.visible && view.subscribed) }
  get busy() { return this.running > 0 || this.hasViewers || !!this.owner || this.driver === 'user' || !!this.initialization }
  state(): BrowserState {
    const capturing = this.hasViewers && this.capturing
    const control: BrowserState['control'] = this.driver === 'agent' && this.owner
      ? { driver: 'agent', ownerSessionId: this.owner.sessionId, fps: capturing ? 2 : 0 }
      : this.driver === 'user' ? { driver: 'user', ownerSessionId: this.owner?.sessionId ?? null, fps: capturing ? 10 : 0 }
      : { driver: 'idle', ownerSessionId: null, fps: capturing ? 2 : 0 }
    return { viewId: this.viewId, control, tabs: [...this.pages].map(([id, page]) => ({ id, url: safeUrl(page.url()), title: this.titles.get(page) ?? '' })), activeTabId: this.activeTabId, viewport: BROWSER_VIEWPORT }
  }
  broadcast(frame?: BrowserServerFrame) {
    for (const [viewer] of this.viewers) viewer.json(frame ?? { type: 'state', state: this.state(), canInput: this.inputOwner === viewer && this.driver === 'user' })
    this.changed()
  }
  updateMarker(bindingId: string, marker: string) {
    if (this.owner?.bindingId === bindingId) this.latestMarkers.set(bindingId, marker)
  }
  owns(caller: ExtensionCaller) { return caller.projectId === this.projectId && caller.sessionId === this.owner?.sessionId }
  acquire(caller: ExtensionSessionCaller): 'ok' | 'busy' | 'waiting-for-user' {
    if (this.closeRequested || this.closing) throw new BrowserFault('unavailable')
    if (this.owner && this.owner.sessionId !== caller.sessionId) return 'busy'
    if (this.driver === 'user') {
      if (!this.owner) { this.owner = caller; this.fence = caller.userTurnId; this.epoch++; this.touch(); this.broadcast() }
      return 'waiting-for-user'
    }
    if (!this.owner) { this.owner = caller; this.driver = 'agent'; this.epoch++; this.broadcast() }
    else this.owner = caller
    this.touch(); return 'ok'
  }
  resume(caller: ExtensionSessionCaller) {
    if (!this.owner || !this.owns(caller)) throw new BrowserFault('forbidden')
    const latest = this.latestMarkers.get(this.owner.bindingId)
    if (this.pendingImport || this.commit || this.closeRequested || this.driver === 'user' && (!caller.userTurnId || caller.userTurnId === this.fence || latest && caller.userTurnId !== latest)) return { status: 'waiting-for-user' as const }
    if (this.driver === 'user') {
      this.owner = caller; this.driver = 'agent'; this.epoch++; this.inputOwner = undefined
      void this.input?.send({ kind: 'release-all' }).catch(() => {})
      this.delivery.mode(false); this.broadcast()
    }
    this.touch(); return { status: 'ok' as const }
  }
  handoff(caller?: ExtensionSessionCaller, reason = 'Take control in Browser, then reply in the same Halo chat.') {
    if (caller && !this.owns(caller)) throw new BrowserFault('forbidden')
    if (this.commit || this.closeRequested) throw new BrowserFault('unavailable')
    if (this.driver !== 'user') {
      this.fence = this.owner ? this.latestMarkers.get(this.owner.bindingId) ?? this.owner.userTurnId : null
      this.driver = 'user'; this.epoch++; this.clearRefs(); this.delivery.mode(true)
    }
    if (caller) this.hooks.open(caller, this.viewId, reason, this.life.signal)
    this.touch(); this.broadcast()
  }
  touch() { this.lastActivity = performance.now(); this.scheduleLease(); this.changed() }
  private get leaseBlocked() { return this.running > 0 || !!this.initialization || !!this.commit || this.closeRequested || this.closing || this.hasViewers && !(this.driver === 'user' && !this.owner) }
  private scheduleLease() {
    clearTimeout(this.leaseTimer)
    if (this.leaseBlocked) return
    const ttl = this.driver === 'user' && this.owner ? BROWSER_LIMITS.handoffTimeoutMs : BROWSER_LIMITS.idleLeaseMs
    this.leaseTimer = setTimeout(() => { if (!this.leaseBlocked) this.expired() }, Math.max(0, ttl - (performance.now() - this.lastActivity)))
  }
  activityStarted() { this.running++; this.scheduleLease(); this.changed() }
  activityEnded() { this.scheduleLease(); this.changed() }
  async ensureContext(): Promise<BrowserContext> {
    checkSignal(this.life.signal)
    if (this.initialization) return this.initialization
    if (this.context) return this.context
    const deadline = setTimeout(() => { this.expired(); if (this.context) killContext(this.context) }, 12 * 60 * 1000)
    this.initialization = (async () => {
      await this.store.init()
      const context = await this.launch(this.store.profile, this.life.signal, runtime => { this.runtime = runtime; this.broadcast({ type: 'runtime', runtime }) })
      try {
        checkSignal(this.life.signal)
        context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(15000)
        await this.store.restore(context) // Before restoring any tab navigation.
        this.context = context
        for (const page of context.pages()) this.registerPage(page)
        context.on('page', page => { this.registerPage(page); this.broadcast() })
        context.on('response', response => {
          // headers() omits Set-Cookie. Inspect presence only; never retain/log its value.
          void response.headerValue('set-cookie').then(value => { if (value !== null) this.scheduleCheckpoint() }).catch(() => {})
        })
        const lost = () => {
          if (this.closing || this.context !== context) return
          // CDP is gone: retain the last durable checkpoint rather than overwrite it with empty state.
          this.context = undefined; this.epoch++; this.life.abort(); this.clearRefs()
          this.runtime = { protocol: 1, status: 'unavailable', reason: 'Browser closed. Open Browser again to restart it.' }
          this.broadcast({ type: 'runtime', runtime: this.runtime }); this.expired()
        }
        const browser = context.browser()
        context.once('close', () => { browser?.off('disconnected', lost); lost() })
        browser?.once('disconnected', lost)
        const saved = await this.store.tabs()
        for (let i = 0; i < saved.urls.length; i++) {
          const page = i === 0 ? context.pages()[0] ?? await context.newPage() : await context.newPage()
          await page.goto(saved.urls[i], { waitUntil: 'domcontentloaded' }).catch(() => {})
        }
        if (!this.pages.size) this.registerPage(await context.newPage())
        const selected = [...this.pages.keys()][saved.selected] ?? [...this.pages.keys()][0]
        await this.select(selected)
        this.runtime = { protocol: 1, status: 'ready', browserVersion: context.browser()?.version() }
        this.broadcast({ type: 'runtime', runtime: this.runtime })
        return context
      } catch (error) { await context.close(); this.context = undefined; throw error }
    })().catch(error => {
      this.runtime = { protocol: 1, status: 'unavailable', reason: 'Browser launch failed. Install the Playwright Chromium shared-library prerequisites on the Halo server; no administrator install is performed.' }
      this.broadcast({ type: 'runtime', runtime: this.runtime }); throw error
    }).finally(() => { clearTimeout(deadline); this.initialization = undefined; this.activityEnded() })
    this.scheduleLease(); this.changed()
    return this.initialization
  }
  private registerPage(page: Page) {
    if ([...this.pages.values()].includes(page)) return
    const id = randomUUID(); this.pages.set(id, page)
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) { if (this.activeTabId === id) this.clearRefs(); this.scheduleCheckpoint(); this.broadcast() } })
    page.on('domcontentloaded', () => { void page.title().then(title => { this.titles.set(page, title.slice(0, 200)); this.broadcast() }).catch(() => {}) })
    page.on('close', () => {
      this.pages.delete(id); this.titles.delete(page)
      if (this.activeTabId === id) {
        this.activeTabId = null; this.clearRefs()
        const next = this.pages.keys().next().value
        if (next && !this.closing) void this.serial(() => this.select(next)).catch(() => {})
      }
      this.broadcast()
    })
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); this.unsupported() })
    page.on('filechooser', () => this.unsupported())
    page.on('download', download => { void download.cancel().catch(() => {}); this.unsupported() })
  }
  private unsupported() { this.broadcast({ type: 'error', error: { code: 'unavailable', message: 'Native dialogs, uploads and download management are not supported in this viewer.' } }) }
  private async select(tabId: string) {
    const page = this.pages.get(tabId)
    if (!page) throw new BrowserFault('not-found')
    await this.input?.send({ kind: 'release-all' }).catch(() => {})
    await this.cdp?.detach().catch(() => {})
    this.capturing = false; this.delivery.clearFrame(); this.clearRefs(); this.activeTabId = tabId
    this.cdp = await page.context().newCDPSession(page); this.input = new InputDispatcher(this.cdp)
    const cdp = this.cdp
    cdp.on('Page.screencastFrame', frame => {
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      if (this.cdp === cdp && this.capturing) this.captured(frame.data)
    })
    await this.captureState(); this.broadcast()
  }
  private captured(data: string) {
    const accepted = this.delivery.capture(Buffer.from(data, 'base64'))
    if (!accepted && !this.oversizedFrame) this.broadcast({ type: 'error', error: { code: 'unavailable', message: 'This page image exceeds the viewer frame budget. Simplify the page to continue streaming.' } })
    this.oversizedFrame = !accepted
  }
  private async captureState() {
    if (!this.cdp) return
    if (this.hasViewers && !this.capturing) {
      this.capturing = true
      await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: BROWSER_JPEG_QUALITY, maxWidth: BROWSER_VIEWPORT.width, maxHeight: BROWSER_VIEWPORT.height })
      const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: BROWSER_JPEG_QUALITY })
      this.captured(data)
    } else if (!this.hasViewers && this.capturing) {
      this.capturing = false; this.delivery.clearFrame(); await this.cdp.send('Page.stopScreencast')
    }
  }
  attach(viewer: Viewer, caller: ExtensionCaller) {
    this.viewers.set(viewer, { caller, subscribed: false, visible: false })
    viewer.json({ type: 'runtime', runtime: this.runtime }); this.broadcast()
  }
  async detach(viewer: Viewer) {
    this.delivery.remove(viewer); this.viewers.delete(viewer)
    if (!this.viewers.size && !this.owner && this.driver === 'user') { this.driver = 'idle'; this.fence = null; this.epoch++; this.delivery.mode(false) }
    if (this.inputOwner === viewer) { this.inputOwner = undefined; await this.serial(() => this.input?.send({ kind: 'release-all' }) ?? Promise.resolve()).catch(() => {}) }
    await this.serial(() => this.captureState()).catch(() => {})
    this.activityEnded(); this.broadcast()
  }
  async viewerMessage(viewer: Viewer, frame: BrowserViewerFrame) {
    const view = this.viewers.get(viewer)
    if (!view) throw new BrowserFault('forbidden')
    if (frame.type === 'frame-ack') { this.delivery.ack(viewer, frame.sequence); return }
    if (frame.type === 'subscribe') {
      if (frame.protocol !== 1) throw new BrowserFault('invalid-request')
      view.subscribed = true; view.visible = true; this.delivery.add(viewer)
      await this.ensureContext()
      await this.serial(async () => { if (frame.tabId && frame.tabId !== this.activeTabId) { if (this.inputOwner !== viewer) throw new BrowserFault('forbidden'); await this.select(frame.tabId) }; await this.captureState() })
    } else if (frame.type === 'visible') {
      if (typeof frame.visible !== 'boolean') throw new BrowserFault('invalid-request')
      view.visible = frame.visible
      if (view.visible && view.subscribed) this.delivery.add(viewer)
      else { this.delivery.remove(viewer); if (this.inputOwner === viewer) { this.inputOwner = undefined; await this.serial(() => this.input?.send({ kind: 'release-all' }) ?? Promise.resolve()) } }
      await this.serial(() => this.captureState())
    } else {
      if (!view.visible || !view.subscribed) throw new BrowserFault('forbidden')
      if (frame.type === 'takeover') {
        if (this.inputOwner && this.inputOwner !== viewer) throw new BrowserFault('forbidden')
        this.handoff(); this.inputOwner = viewer
      } else {
        if (this.inputOwner !== viewer || this.driver !== 'user') throw new BrowserFault('forbidden')
        const epoch = this.epoch
        const event = frame.type === 'input' ? validateInput(frame.event) : undefined
        await this.serial(async () => {
          if (epoch !== this.epoch || this.inputOwner !== viewer) throw new BrowserFault('forbidden')
          if (frame.type === 'select-tab') await this.select(frame.tabId)
          else if (event) await this.input?.send(event)
          else throw new BrowserFault('invalid-request')
        })
        const meaningful = frame.type === 'select-tab' || event?.kind === 'text' || event?.kind === 'wheel' || (event?.kind === 'pointer' || event?.kind === 'key') && event.event === 'down'
        if (meaningful || this.checkpointDirty) this.scheduleCheckpoint(meaningful)
      }
    }
    this.touch(); this.broadcast()
  }
  serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.tail.then(work)
    this.tail = task.catch(() => {})
    return task
  }
  async withCommit<T>(caller: ExtensionSessionCaller, signal: AbortSignal, work: (target: SigninCommit) => Promise<T>): Promise<T> {
    checkSignal(signal)
    const context = await this.ensureContext()
    return this.serial(async () => {
      checkSignal(signal); checkSignal(this.life.signal)
      if (!this.owns(caller) || this.closeRequested || this.closing || !this.pendingImport || context !== this.context) throw new BrowserFault('forbidden')
      let finish!: () => void; let interrupt!: (error: Error) => void; let active = true
      const interrupted = new Promise<never>((_, reject) => { interrupt = reject })
      const guard = { context, done: new Promise<void>(resolve => { finish = resolve }), invalidate: () => { active = false; interrupt(new BrowserFault('unavailable')) } }
      const validate = () => { if (!active || this.commit !== guard || this.context !== context || this.closing) throw new BrowserFault('unavailable') }
      const target: SigninCommit = {
        withContext: async task => {
          validate(); checkSignal(signal); checkSignal(this.life.signal)
          const result = await task(context)
          validate(); checkSignal(signal); checkSignal(this.life.signal); return result
        },
        cleanup: async task => { validate(); const result = await task(context); validate(); return result },
        checkpoint: async () => { validate(); await this.saveCheckpoint(context); validate() },
      }
      this.commit = guard
      const timer = setTimeout(() => this.expired(), BROWSER_LIMITS.commandTimeoutMs)
      try { return await Promise.race([work(target), interrupted]) }
      finally { clearTimeout(timer); active = false; this.commit = undefined; finish() }
    })
  }
  private page() { const page = this.activeTabId ? this.pages.get(this.activeTabId) : undefined; if (!page) throw new BrowserFault('not-found'); return page }
  private clearRefs() { this.snapshotId = ''; for (const ref of this.refs.values()) void ref.dispose().catch(() => {}); this.refs.clear() }
  private async readPage(): Promise<BrowserPageRead> {
    this.clearRefs()
    const page = this.page(); const snapshotId = randomUUID(); this.snapshotId = snapshotId
    const text = await page.locator('body').innerText()
    const aria = await page.locator('body').ariaSnapshot()
    const refs: BrowserPageRead['refs'] = []
    const targets = page.locator('a,button,input,textarea,select,[role],[contenteditable="true"]')
    const targetCount = await targets.count()
    for (let index = 0; index < Math.min(targetCount, 200); index++) {
      const handle = await targets.nth(index).elementHandle()
      if (!handle) continue
      if (!await handle.isVisible()) { await handle.dispose(); continue }
      const meta = await handle.evaluate(node => { const el = node as Element; return { role: el.getAttribute('role') ?? el.tagName.toLowerCase(), name: (el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.textContent ?? '').slice(0, 160) } })
      const id = `r${refs.length + 1}`; this.refs.set(id, handle); refs.push({ id, ...meta })
    }
    if (this.snapshotId !== snapshotId) throw new BrowserFault('stale-ref')
    return { tabId: this.activeTabId!, url: safeUrl(page.url()), title: (await page.title()).slice(0, 200), text: text.slice(0, BROWSER_LIMITS.pageTextChars), ariaSnapshot: aria.slice(0, BROWSER_LIMITS.snapshotChars), snapshotId, refs, truncated: text.length > BROWSER_LIMITS.pageTextChars || aria.length > BROWSER_LIMITS.snapshotChars || targetCount > 200 }
  }
  async command(caller: ExtensionSessionCaller, request: BrowserCommandRequest, signal: AbortSignal, epoch: number): Promise<BrowserCommandResults[BrowserCommandName]> {
    if (request.op === 'control.resume') return this.resume(caller)
    if (request.op === 'handoff') { this.handoff(caller, request.args.reason); return { status: 'waiting-for-user' } }
    await this.ensureContext()
    return this.serial(async () => {
      const fence = () => { checkSignal(signal); if (!this.owns(caller) || epoch !== this.epoch || this.driver !== 'agent') throw new BrowserFault('forbidden') }
      fence()
      let result: BrowserCommandResults[BrowserCommandName]
      switch (request.op) {
        case 'open': {
          let page = this.activeTabId ? this.pages.get(this.activeTabId) : undefined
          if (!page) {
            page = await this.context!.newPage(); this.registerPage(page)
            await this.select([...this.pages].find(([, candidate]) => candidate === page)![0])
          }
          await page.goto(request.args.url, { waitUntil: 'domcontentloaded' })
          result = { viewId: this.viewId, tab: { id: this.activeTabId!, title: (await page.title()).slice(0, 200), url: safeUrl(page.url()) } }
          this.hooks.open(caller, this.viewId, 'Browser is ready to open in Canvas.', this.life.signal); break
        }
        case 'read': result = await this.readPage(); break
        case 'click': case 'type': {
          const ref = this.refs.get(request.args.ref)
          if (request.args.snapshotId !== this.snapshotId || !ref || !await ref.evaluate(el => el.isConnected)) throw new BrowserFault('stale-ref')
          if (request.op === 'click') await ref.click(); else await ref.fill(request.args.text)
          this.clearRefs()
          result = { status: 'ok' }; break
        }
        case 'press': await this.page().keyboard.press(request.args.key); result = { status: 'ok' }; break
        case 'scroll': await this.page().mouse.wheel(request.args.dx, request.args.dy); result = { status: 'ok' }; break
        case 'select-tab': await this.select(request.args.tabId); result = { status: 'ok' }; break
        case 'tabs': result = { tabs: this.state().tabs, activeTabId: this.activeTabId }; break
        case 'screenshot': {
          const page = this.page(); const deadline = performance.now() + 10000
          const remaining = () => { const ms = deadline - performance.now(); if (ms <= 0) throw new BrowserFault('operation-failed'); return ms }
          const withinBudget = async <T>(work: () => Promise<T>): Promise<T> => {
            const ms = remaining(); let timer: ReturnType<typeof setTimeout> | undefined
            try { return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BrowserFault('operation-failed')), ms) })]) }
            finally { clearTimeout(timer) }
          }
          let data: Buffer
          try { data = await withinBudget(() => page.screenshot({ type: 'png', timeout: remaining() })) }
          catch (error) {
            if (!(error instanceof Error) || error.message.split('\n')[0] !== 'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot') throw error
            // Chromium 149 returns this for an empty surface copy, not encoding/delivery failure.
            // Until Chromium fixes surface readiness, retry once after foreground + visible paint, within the same budget.
            fence(); await withinBudget(() => page.bringToFront())
            const visible = await withinBudget(() => page.waitForFunction(() => document.visibilityState === 'visible' && new Promise<boolean>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.visibilityState === 'visible')))), undefined, { timeout: remaining() }))
            try { fence(); data = await withinBudget(() => page.screenshot({ type: 'png', timeout: remaining() })) }
            finally { await withinBudget(() => visible.dispose()).catch(() => {}) }
          }
          fence()
          if (data.length > BROWSER_LIMITS.screenshotBytes) throw new BrowserFault('unavailable')
          await this.sweepArtifacts()
          if (this.artifacts.size >= 32) throw new BrowserFault('unavailable')
          const artifactId = randomUUID(); const file = join(this.store.directory, 'artifacts', artifactId + '.png')
          await writeFile(file, data, { mode: 0o600 })
          this.artifacts.set(artifactId, { file, sessionId: caller.sessionId, expires: Date.now() + 5 * 60 * 1000 })
          result = { artifactId, mimeType: 'image/png', bytes: data.length, ...BROWSER_VIEWPORT }; break
        }
        default: throw new BrowserFault('invalid-request')
      }
      fence()
      if (!['read', 'tabs', 'screenshot'].includes(request.op)) await this.checkpointNow()
      fence()
      this.touch(); this.broadcast(); return result
    })
  }
  async artifact(caller: ExtensionSessionCaller, id: string): Promise<Buffer> {
    if (!this.owns(caller) || this.driver !== 'agent') throw new BrowserFault('forbidden')
    await this.sweepArtifacts()
    const artifact = this.artifacts.get(id)
    if (!artifact || artifact.sessionId !== caller.sessionId) throw new BrowserFault('not-found')
    const epoch = this.epoch; const data = await readFile(artifact.file)
    if (epoch !== this.epoch || this.driver !== 'agent') throw new BrowserFault('forbidden')
    return data
  }
  private async sweepArtifacts() {
    const directory = join(this.store.directory, 'artifacts')
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9-]+\.png$/.test(name)) continue
      const file = join(directory, name)
      if ((await stat(file)).mtimeMs + 5 * 60 * 1000 <= Date.now()) { await rm(file, { force: true }); this.artifacts.delete(name.slice(0, -4)) }
    }
  }
  private scheduleCheckpoint(dirty = true) {
    if (this.closeRequested || this.closing) return
    this.checkpointDirty ||= dirty
    if (!this.checkpointDirty) return
    // Debounce until interaction settles; movement/releases only defer an already dirty checkpoint.
    clearTimeout(this.checkpointTimer)
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined
      void this.serial(async () => { if (this.checkpointDirty && !this.checkpointTimer) await this.checkpointNow() }).catch(() => { this.broadcast({ type: 'error', error: { code: 'operation-failed', message: 'Browser checkpoint failed; changes may not survive restart.' } }) })
    }, 500)
  }
  async checkpointNow() {
    if (this.closeRequested || this.commit) throw new BrowserFault('unavailable')
    await this.saveCheckpoint(this.context)
  }
  private async saveCheckpoint(context: BrowserContext | undefined) {
    const validate = () => { if (!context || context !== this.context || this.closing) throw new BrowserFault('unavailable') }
    validate()
    clearTimeout(this.checkpointTimer); this.checkpointTimer = undefined; this.checkpointDirty = false
    await this.store.checkpoint(context!)
    validate()
    const tabs = await Promise.all([...this.pages.values()].map(async page => ({ url: safeUrl(page.url()), title: (await page.title().catch(() => '')).slice(0, 200) })))
    validate()
    await this.store.save('tabs.json', { tabs, selected: [...this.pages.keys()].indexOf(this.activeTabId ?? '') })
    validate()
  }
  private closeTask?: Promise<void>
  close(shutdownMs?: number): Promise<void> {
    this.closeTask ??= this.closeBrowser()
    if (shutdownMs === undefined) return this.closeTask
    // Process stop can shorten an already-running live close, without leaving a timer after it finishes.
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([this.closeTask, new Promise<void>(resolve => {
      timer = setTimeout(() => { this.forceClose(); resolve() }, shutdownMs)
    })]).finally(() => { clearTimeout(timer) })
  }
  private forceClose() {
    const context = this.commit?.context ?? this.context
    if (this.commit) {
      this.commit.invalidate()
      this.runtime = { protocol: 1, status: 'unavailable', reason: 'Browser import cleanup timed out; sign-in state is uncertain.' }
      this.broadcast({ type: 'runtime', runtime: this.runtime })
    }
    this.closing = true; this.context = undefined
    if (context) killContext(context)
  }
  private async closeBrowser() {
    this.closeRequested = true; this.epoch++; this.life.abort()
    clearTimeout(this.leaseTimer); clearTimeout(this.checkpointTimer)
    const guard = this.commit
    if (guard) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([guard.done, new Promise<void>(resolve => { timer = setTimeout(() => {
          this.forceClose(); resolve()
        }, BROWSER_LIMITS.commandTimeoutMs) })])
      } finally { clearTimeout(timer) }
    }
    await this.initialization?.catch(() => {})
    // A wedged command must not prevent closing the context/process. Never save tentative cookies after forced teardown.
    const context = this.context ?? guard?.context
    if (context) {
      const deadline = setTimeout(() => killContext(context), 3000)
      try {
        // The guarded import already persisted commit/undo, or reported uncertainty. Do not checkpoint tentative state again.
        if (!guard && !this.closing) await this.saveCheckpoint(context).catch(() => {})
        this.closing = true
        await context.close().catch(() => {})
      } finally { clearTimeout(deadline) }
    }
    this.closing = true
    this.delivery.close(); for (const viewer of this.viewers.keys()) viewer.close(); this.viewers.clear()
    this.context = undefined; this.owner = undefined; this.driver = 'idle'; this.clearRefs(); this.changed()
  }
}
