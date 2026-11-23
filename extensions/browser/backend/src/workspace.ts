import { createHash, randomUUID } from 'node:crypto'
import { writeFile, rm, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext, CDPSession, ElementHandle, Page } from 'playwright'
import type { ExtensionCaller, ExtensionSessionCaller } from '../../contracts/halo-core/extension-notices.js'
import { BROWSER_LIMITS, BROWSER_VIEWPORT, BROWSER_JPEG_QUALITY, isReadCommand, type BrowserCommandRequest, type BrowserCommandResults, type BrowserCommandName, type BrowserState, type BrowserRuntimeInfo, type BrowserServerFrame, type BrowserPageRead, type BrowserViewerFrame } from './protocol.js'
import { BrowserFault, BrowserLaunchFault, checkSignal, safeUrl } from './errors.js'
import { ProfileStore } from './profile-store.js'
import { FrameDelivery, type FramePeer } from './frame-delivery.js'
import { InputDispatcher, validateInput } from './input.js'
import type { BrowserLauncher } from './browser-launcher.js'
import type { Hooks } from './hooks.js'
import { killContext } from './lifecycle.js'
import type { SigninCommit } from './signin-service.js'
import { httpUrl, opaque } from './validation.js'

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
  inputReleased: Promise<void> = Promise.resolve()
  private fence: string | null = null
  private latestMarkers = new Map<string, string>()
  private epoch = 0
  private context?: BrowserContext
  private stoppingContext?: BrowserContext
  private contextExited?: Promise<void>
  private contextClosing?: Promise<void>
  get stopping() { return this.closeRequested || this.closing }
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
  acquire(caller: ExtensionSessionCaller, readOnly = false): 'ok' | 'busy' | 'waiting-for-user' {
    if (this.owner && this.owner.sessionId !== caller.sessionId) return 'busy'
    if (this.closeRequested && this.driver === 'user' && !readOnly) return 'waiting-for-user'
    if (this.closeRequested || this.closing) throw new BrowserFault('unavailable')
    if (this.driver === 'user') {
      if (!this.owner) {
        // UUID markers cannot order an ownerless takeover against an existing turn.
        // Accept the first claimant's current turn rather than requiring another user message.
        this.owner = caller; this.fence = null; this.epoch++; this.touch(); this.broadcast()
      }
      if (readOnly) { this.touch(); return 'ok' }
      const latest = this.latestMarkers.get(this.owner.bindingId)
      if (this.pendingImport || this.commit || !caller.userTurnId || caller.userTurnId === this.fence || latest && caller.userTurnId !== latest) return 'waiting-for-user'
      this.owner = caller; this.driver = 'agent'; this.epoch++; this.inputOwner = undefined
      // Queue behind in-flight viewer input; agent execution awaits this release barrier.
      this.inputReleased = this.serial(async () => {
        const page = this.activeTabId ? this.pages.get(this.activeTabId) : undefined
        const input = this.input
        try { await input?.send({ kind: 'release-all' }) }
        catch {
          // Only a confirmed closed target can discard held state; do not infer closure from error text.
          if (page?.isClosed()) { if (this.input === input) this.input = undefined; return }
          this.inputReleased = Promise.resolve(); this.input = undefined; this.epoch++; this.clearRefs()
          this.runtime = { protocol: 1, status: 'unavailable', reason: 'Browser input cleanup failed. Open Browser again to restart it.' }
          // Preserve the last checkpoint, as on unexpected exit; do not save the failed live context.
          this.forceClose(); this.broadcast({ type: 'runtime', runtime: this.runtime }); this.expired()
          throw new BrowserFault('unavailable')
        }
      })
      this.delivery.mode(false); this.broadcast()
    }
    if (!this.owner) { this.owner = caller; this.driver = 'agent'; this.epoch++; this.broadcast() }
    else this.owner = caller
    this.touch(); return 'ok'
  }
  handoff(caller?: ExtensionSessionCaller, reason = 'Interact with the browser directly in Canvas, then reply in this chat when finished.') {
    if (caller && !this.owns(caller)) throw new BrowserFault('forbidden')
    if (this.commit || this.closeRequested) throw new BrowserFault('unavailable')
    if (this.driver !== 'user') {
      this.fence = this.owner ? this.latestMarkers.get(this.owner.bindingId) ?? this.owner.userTurnId : null
      this.driver = 'user'; this.epoch++; this.clearRefs(); this.delivery.mode(true)
    }
    if (caller) this.openViewer(caller, reason, this.life.signal)
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
    if (this.stopping) throw new BrowserFault('unavailable')
    checkSignal(this.life.signal)
    if (this.initialization) return this.initialization
    if (this.context) return this.context
    const deadline = setTimeout(() => { this.expired(); if (this.context) killContext(this.context) }, 12 * 60 * 1000)
    this.initialization = (async () => {
      await this.store.init()
      const context = await this.launch(this.store.profile, this.life.signal, runtime => { this.runtime = runtime; this.broadcast({ type: 'runtime', runtime }) })
      this.contextExited = undefined; this.contextClosing = undefined; this.observeExit(context)
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
      const failure = error instanceof BrowserLaunchFault ? error : new BrowserLaunchFault(error)
      if (!(error instanceof BrowserLaunchFault)) console.error(`[Browser] ${failure.message}`)
      this.runtime = { protocol: 1, status: 'unavailable', reason: failure.message }
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
  private async newTab() {
    const page = await this.context!.newPage(); this.registerPage(page)
    await this.select([...this.pages].find(([, candidate]) => candidate === page)![0])
  }
  private async closeTab(tabId: string) {
    const page = this.pages.get(tabId)
    if (!page) throw new BrowserFault('not-found')
    // Select the replacement before close so the page-close listener cannot queue a stale selection.
    if (this.pages.size === 1) await this.newTab()
    else if (this.activeTabId === tabId) await this.select([...this.pages.keys()].find(id => id !== tabId)!)
    await page.close()
  }
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
  private openViewer(caller: ExtensionSessionCaller, message: string, signal: AbortSignal) {
    if (!this.viewers.size) this.hooks.open(caller, this.viewId, message, signal)
  }
  attach(viewer: Viewer, caller: ExtensionCaller) {
    this.viewers.set(viewer, { caller, subscribed: false, visible: false })
    this.hooks.withdrawOpen(caller, this.viewId)
    if (this.owner) this.hooks.withdrawOpen(this.owner, this.viewId)
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
        if (frame.type === 'navigate' && !httpUrl(frame.url) || (frame.type === 'select-tab' || frame.type === 'close-tab') && !opaque(frame.tabId)) throw new BrowserFault('invalid-request')
        await this.serial(async () => {
          if (epoch !== this.epoch || this.inputOwner !== viewer || this.driver !== 'user') throw new BrowserFault('forbidden')
          switch (frame.type) {
            case 'select-tab': await this.select(frame.tabId); break
            case 'navigate': await this.page().goto(frame.url, { waitUntil: 'domcontentloaded' }); break
            case 'back': await this.page().goBack({ waitUntil: 'domcontentloaded' }); break
            case 'forward': await this.page().goForward({ waitUntil: 'domcontentloaded' }); break
            case 'reload': await this.page().reload({ waitUntil: 'domcontentloaded' }); break
            case 'new-tab': await this.newTab(); break
            case 'close-tab': await this.closeTab(frame.tabId); break
            case 'input': await this.input?.send(event!); break
            default: throw new BrowserFault('invalid-request')
          }
        })
        const meaningful = frame.type !== 'input' || event?.kind === 'text' || event?.kind === 'wheel' || (event?.kind === 'pointer' || event?.kind === 'key') && event.event === 'down'
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
    const before = await this.passwordValues(page)
    const text = await page.locator('body').innerText()
    const aria = (await page.locator('body').ariaSnapshot({ mode: 'ai' })).replace(/\s*\[ref=[^\]]+\]/g, '')
    const refs: BrowserPageRead['refs'] = []
    const targets = page.locator('a,button,input,textarea,select,[role],[contenteditable="true"]')
    const targetCount = await targets.count()
    for (let index = 0; index < Math.min(targetCount, 200); index++) {
      const handle = await targets.nth(index).elementHandle()
      if (!handle) continue
      if (!await handle.isVisible()) { await handle.dispose(); continue }
      const meta = await handle.evaluate(node => { const el = node as Element; return { role: el.getAttribute('role') ?? el.tagName.toLowerCase(), name: el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.textContent ?? '' } })
      const id = `r${refs.length + 1}`; this.refs.set(id, handle); refs.push({ id, ...meta })
    }
    const result: BrowserPageRead = { tabId: this.activeTabId!, url: safeUrl(page.url()), title: await page.title(), text, ariaSnapshot: aria, snapshotId, refs, truncated: text.length > BROWSER_LIMITS.pageTextChars || aria.length > BROWSER_LIMITS.snapshotChars || targetCount > 200 }
    const after = await this.passwordValues(page)
    if (before.size !== after.size || [...before].some(value => !after.has(value))) throw new BrowserFault('operation-failed')
    if (this.snapshotId !== snapshotId) throw new BrowserFault('stale-ref')
    // Compare title and decoded URL components in the same browser-normalized space.
    const normalizeContent = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/[\u200b-\u200d\ufeff\u2060\u00ad]/g, '').replace(/\s+/g, ' ').trim()
    const normalize = (value: string) => value.replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ')
    const variants = [...before].flatMap(value => {
      const visible = value.replace(/[\u200b-\u200d\ufeff\u2060]/g, '')
      return [value, normalize(value), visible, normalize(visible), normalizeContent(value)]
    }).flatMap(value => [value, value.replace(/[\t\r\n]/g, '')]) // URL parsing drops ASCII tabs/newlines.
      .flatMap(value => [value, value.replace(/\s*\[ref=[^\]]+\]/g, '')])
    const normalizedPasswords = [...new Set(variants.map(normalizeContent).filter(Boolean))].sort((a, b) => b.length - a.length)
    result.title = normalizeContent(result.title)
    for (const password of normalizedPasswords) result.title = result.title.split(password).join('••••')
    const matches = (value: string) => normalizedPasswords.some(password => normalizeContent(value).includes(password))
    const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }
    try {
      const url = new URL(result.url)
      url.pathname = url.pathname.split('/').map(segment => matches(decode(segment)) ? '••••' : segment).join('/')
      const params = [...url.searchParams]
      if (params.some(([key, value]) => matches(key) || matches(value))) {
        url.search = ''
        for (const [key, value] of params) url.searchParams.append(matches(key) ? '••••' : key, matches(value) ? '••••' : value)
      }
      if (matches(decode(url.hash.slice(1)))) url.hash = '••••'
      result.url = url.href
    } catch { result.url = 'about:blank' }
    // ARIA quotes values and derived names. Include each variant's escaped spellings too.
    const passwords = [...new Set(variants.filter(Boolean).flatMap(value => {
      const quoted = JSON.stringify(value).slice(1, -1)
      const yamlQuoted = quoted.replace(/\\u00([0-9a-f]{2})|[\x7f-\x9f]/g, (char, hex: string | undefined) => '\\x' + (hex ?? char.charCodeAt(0).toString(16)))
      return [value, quoted, yamlQuoted, value.replace(/'/g, "''"), quoted.replace(/'/g, "''")]
    }))].sort((a, b) => b.length - a.length)
    const redact = (value: string) => { for (const password of passwords) value = value.split(password).join('••••'); return value }
    // Strip ARIA refs first, then redact content before truncation; protocol IDs and roles stay intact.
    for (const key of ['text', 'ariaSnapshot'] as const) result[key] = redact(result[key])
    for (const ref of refs) ref.name = redact(ref.name).slice(0, 160)
    result.title = result.title.slice(0, 200); result.text = result.text.slice(0, BROWSER_LIMITS.pageTextChars)
    result.ariaSnapshot = result.ariaSnapshot.slice(0, BROWSER_LIMITS.snapshotChars)
    return result
  }
  private async passwordValues(page: Page): Promise<Set<string>> {
    const values = await Promise.all(page.frames().map(async frame => {
      try { return await frame.locator('input[type=password]').evaluateAll(els => els.map(el => (el as HTMLInputElement).value)) }
      catch { if (frame.isDetached()) return []; throw new BrowserFault('operation-failed') }
    }))
    // Locators and Playwright's ARIA snapshot traverse open, not closed, shadow roots.
    // Closed-root values are unavailable; values copied outside those roots cannot be recognized here.
    // Best-effort samples miss A→B→A changes, empty→value→empty, and frames mounted then removed between samples.
    return new Set(values.flat().filter(Boolean))
  }
  async command(caller: ExtensionSessionCaller, request: BrowserCommandRequest, signal: AbortSignal, epoch: number): Promise<BrowserCommandResults[BrowserCommandName]> {
    await this.inputReleased
    if (request.op === 'handoff') { this.handoff(caller, request.args.reason); return { status: 'waiting-for-user' } }
    await this.ensureContext()
    return this.serial(async () => {
      const fence = () => { checkSignal(signal); if (!this.owns(caller) || epoch !== this.epoch || !isReadCommand(request.op) && this.driver !== 'agent') throw new BrowserFault('forbidden') }
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
          this.openViewer(caller, 'Browser is ready to open in Canvas.', this.life.signal); break
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
        case 'close-tab': await this.closeTab(request.args.tabId); result = { status: 'ok' }; break
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
      if (!isReadCommand(request.op)) await this.checkpointNow()
      fence()
      this.touch(); this.broadcast(); return result
    })
  }
  async artifact(caller: ExtensionSessionCaller, id: string): Promise<Buffer> {
    if (!this.owns(caller)) throw new BrowserFault('forbidden')
    await this.sweepArtifacts()
    const artifact = this.artifacts.get(id)
    if (!artifact || artifact.sessionId !== caller.sessionId) throw new BrowserFault('not-found')
    return readFile(artifact.file)
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
    this.closeTask ??= this.closeBrowser().catch(error => { this.closeTask = undefined; throw error })
    if (shutdownMs === undefined) return this.closeTask
    // Process stop can shorten an already-running live close, without leaving a timer after it finishes.
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([this.closeTask, new Promise<void>(resolve => {
      timer = setTimeout(() => { this.forceClose(); resolve() }, shutdownMs)
    })]).finally(() => { clearTimeout(timer) })
  }
  private observeExit(context: BrowserContext) {
    this.contextExited ??= new Promise<void>(resolve => { context.once('close', () => resolve()) })
    return this.contextExited
  }
  private async waitForExit(exited: Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserFault('unavailable')), BROWSER_LIMITS.contextCloseTimeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
  private forceClose() {
    const context = this.commit?.context ?? this.context ?? this.stoppingContext
    if (this.commit) {
      this.commit.invalidate()
      this.runtime = { protocol: 1, status: 'unavailable', reason: 'Browser import cleanup timed out; sign-in state is uncertain.' }
      this.broadcast({ type: 'runtime', runtime: this.runtime })
    }
    this.closing = true; this.context = undefined
    if (context) { this.stoppingContext = context; this.observeExit(context); killContext(context) }
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
    const context = this.context ?? this.stoppingContext ?? guard?.context
    if (context) {
      this.observeExit(context)
      const deadline = setTimeout(() => this.forceClose(), BROWSER_LIMITS.contextCloseTimeoutMs)
      try {
        // The guarded import already persisted commit/undo, or reported uncertainty. Do not checkpoint tentative cookies.
        if (!guard && !this.closing) await this.saveCheckpoint(context).catch(() => {})
        const forced = !!this.stoppingContext
        this.closing = true
        // Keep the first close promise: Playwright's subsequent close() can return while still closing.
        this.contextClosing ??= context.close().catch(() => {}).then(() => this.contextExited!)
        // Graceful close also waits Playwright's process cleanup, not just its earlier context event.
        await this.waitForExit(forced ? Promise.race([this.contextClosing, this.contextExited!]) : this.contextClosing)
      } catch (error) {
        if (this.runtime.status !== 'unavailable') {
          this.runtime = { protocol: 1, status: 'unavailable', reason: 'Browser is still stopping. Open Browser again after it exits.' }
          this.broadcast({ type: 'runtime', runtime: this.runtime })
        }
        throw error
      } finally { clearTimeout(deadline) }
    }
    this.stoppingContext = undefined
    this.closing = true
    this.delivery.close(); for (const viewer of this.viewers.keys()) viewer.close(); this.viewers.clear()
    this.context = undefined; this.owner = undefined; this.driver = 'idle'; this.clearRefs(); this.changed()
  }
}
