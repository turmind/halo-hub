import { BROWSER_FRAME_HEADER_BYTES, BROWSER_PROTOCOL_VERSION, BROWSER_VIEWPORT,
  type BrowserServerFrame, type BrowserState, type BrowserViewerFrame, type BrowserViewRequest, type BrowserViewResponse } from '../backend/src/protocol.js'
import { EXTENSION_THEME_TOKENS, type ExtensionClientFrame, type ExtensionHostFrame,
  type ExtensionLang, type ExtensionThemeVars } from '../contracts/halo-core/extension-frames.js'
import { EXTENSION_VIEW_CONTEXT_HEADER, EXTENSION_VIEW_CONTEXT_QUERY,
  type ExtensionCanvasInitFrame, type ExtensionViewContext } from '../contracts/halo-core/extension-notices.js'
import { fitViewport } from './geometry.js'
import { bindInput } from './input.js'
import { addressUrl } from './navigation.js'

const labels = {
  en: {
    back: 'Back', forward: 'Forward', reload: 'Reload', newTab: 'New tab', closeTab: 'Close tab', address: 'Address (http/https)', tabs: 'Browser tabs',
    reconnect: 'Reconnect', waiting: 'Waiting for browser…', invalidUrl: 'Enter an http or https URL. Other schemes and search queries are not supported.',
    connecting: 'Connecting…', disconnected: 'Disconnected · read-only', hidden: 'Hidden · stream paused',
    watching: 'Read-only · watching', driving: 'You are driving · agent paused', agent: 'Agent is driving',
    paused: 'Agent paused. When you finish, return to the same Halo chat and tell the agent what to do next.',
    watchHint: 'Click the page, type or use browser controls to take over. Only one viewer can control this workspace’s browser. When finished, reply in the same Halo chat to continue.',
    userHint: 'Agent paused. This viewer is read-only while another viewer holds input control. When finished, reply in the same Halo chat to continue.',
    limits: 'Runs on the Halo server · limitations',
    limitsText: 'Sign-ins are shared by later sessions in this workspace. Text paste is supported; clipboard copy, file upload/download management, audio/video calls, passkeys and native permission dialogs are not supported here.',
    textLimit: 'Text is too long. Paste at most 4,096 characters at a time.', clipboard: 'Remote clipboard copy/cut is not supported. Text paste is supported.',
    failed: 'Could not connect. Check that the backend is enabled and confirmed in Halo Settings, then reconnect.',
    forbidden: 'Another viewer is driving. This viewer remains read-only.',
    decode: 'Could not decode a browser frame. Reconnect to try again.', protocol: 'Open this view in Halo 2.4.0 or later from Canvas.',
  },
  zh: {
    back: '后退', forward: '前进', reload: '刷新', newTab: '新标签页', closeTab: '关闭标签页', address: '地址（http/https）', tabs: '浏览器标签页',
    reconnect: '重新连接', waiting: '等待浏览器…', invalidUrl: '请输入 http 或 https 网址，不支持其他协议或搜索词。',
    connecting: '连接中…', disconnected: '已断开 · 只读', hidden: '已隐藏 · 画面暂停',
    watching: '只读观看中', driving: '你在操作 · agent已暂停', agent: 'agent在操作',
    paused: '智能体已暂停。完成后，请返回同一个 Halo 聊天，告诉智能体下一步做什么。',
    watchHint: '点击画面、键盘输入或使用浏览器控件即可接管；同一工作区同时只能由一个查看器操作。完成后在同一个 Halo 聊天回复智能体继续。',
    userHint: '智能体已暂停。另一个查看器正在操作时，当前查看器保持只读。完成后在同一个 Halo 聊天回复智能体继续。',
    limits: '运行在 Halo 服务器上 · 使用限制',
    limitsText: '登录状态与此工作区后续会话共享。支持粘贴文本；不支持复制远程剪贴板、文件上传/下载管理、音视频通话、通行密钥和系统权限对话框。',
    textLimit: '文本太长，每次最多粘贴 4,096 个字符。', clipboard: '不支持远程剪贴板复制/剪切，支持粘贴文本。',
    failed: '连接失败。请在 Halo 设置中确认后端已启用并获准运行，然后重新连接。',
    forbidden: '另一个查看器正在操作，当前查看器保持只读。',
    decode: '浏览器画面解码失败，请重新连接。', protocol: '请在 Halo 2.4.0 或更高版本的 Canvas 中打开。',
  },
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const screen = element<HTMLCanvasElement>('screen')
const surface = element<HTMLDivElement>('surface')
const input = element<HTMLTextAreaElement>('input')
const address = element<HTMLInputElement>('address')
const info = element<HTMLButtonElement>('info')
const limits = element<HTMLDivElement>('limits')
const reconnect = element<HTMLButtonElement>('reconnect')
const tabs = element<HTMLElement>('tabs')
const error = element<HTMLParagraphElement>('error')
const empty = element<HTMLParagraphElement>('empty')
const context2d = screen.getContext('2d')!
let lang: ExtensionLang = 'en'
let init: ExtensionCanvasInitFrame | undefined
let state: BrowserState | undefined
let canInput = false
let connected = false
let pendingTakeover = false
let pendingFrames: BrowserViewerFrame[] = []
let socket: WebSocket | undefined
let request: AbortController | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectAttempts = 0
let generation = 0
let stopped = false
let tabKey = ''
let addressTab: string | null | undefined
const t = () => labels[lang]
const host = (frame: ExtensionClientFrame) => window.parent.postMessage(frame, window.location.origin)
const send = (frame: BrowserViewerFrame) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)) }
const showError = (message: string) => { error.textContent = message; error.hidden = !message }
const viewport = () => state?.viewport ?? BROWSER_VIEWPORT
function activate() {
  if (!connected) return false
  if (!canInput && !pendingTakeover) { pendingTakeover = true; showError(''); send({ type: 'takeover' }) }
  return true
}
function controlled(frame: BrowserViewerFrame) {
  if (canInput) send(frame)
  // Preserve the first gesture until the server grants ownership; forbidden drops it, never steals control.
  else if (pendingTakeover) pendingFrames.push(frame)
}
const release = bindInput(screen, input, viewport, () => canInput || pendingTakeover,
  event => controlled({ type: 'input', event }), key => showError(t()[key]), activate, () => canInput)
function control(frame: BrowserViewerFrame) {
  release()
  if (activate()) { showError(''); controlled(frame) }
}

function layout() {
  const fit = fitViewport(surface.clientWidth, surface.clientHeight, viewport())
  Object.assign(screen.style, { width: `${fit.width}px`, height: `${fit.height}px`, left: `${fit.left}px`, top: `${fit.top}px` })
  Object.assign(input.style, { left: `${fit.left}px`, top: `${fit.top}px` })
}
new ResizeObserver(layout).observe(surface)
function render() {
  for (const node of document.querySelectorAll<HTMLElement>('[data-label]')) node.textContent = t()[node.dataset.label as keyof typeof labels.en]
  for (const node of document.querySelectorAll<HTMLElement>('[data-title]')) {
    node.title = t()[node.dataset.title as keyof typeof labels.en]; node.setAttribute('aria-label', node.title)
  }
  reconnect.textContent = t().reconnect
  for (const id of ['back', 'forward', 'reload', 'new-tab', 'address', 'input']) element<HTMLButtonElement>(id).disabled = !connected
  screen.setAttribute('aria-label', canInput ? t().driving : t().watching)
  const mode = element('mode')
  mode.textContent = !connected ? document.hidden ? t().hidden : t().disconnected
    : `${canInput ? t().driving : state?.control.driver === 'agent' ? t().agent : t().watching} · ${state?.control.fps ?? 0} fps`
  mode.title = canInput ? t().paused : state?.control.driver === 'user' ? t().userHint : t().watchHint
  mode.setAttribute('aria-label', `${mode.textContent}. ${mode.title}`)
  const active = state?.tabs.find(tab => tab.id === state?.activeTabId)
  if (document.activeElement !== address || addressTab !== state?.activeTabId) address.value = active?.url === 'about:blank' ? '' : active?.url ?? ''
  addressTab = state?.activeTabId
  tabs.hidden = (state?.tabs.length ?? 0) < 2
  const key = JSON.stringify([state?.tabs, state?.activeTabId, connected, lang])
  if (key !== tabKey) {
    tabKey = key; tabs.replaceChildren()
    for (const tab of state?.tabs ?? []) {
      const group = document.createElement('div')
      group.className = 'flex max-w-64 shrink-0 items-center rounded text-xs'
      group.classList.toggle('bg-accent', tab.id === state?.activeTabId)
      const button = document.createElement('button')
      button.className = 'min-w-0 truncate rounded px-2 py-1 hover:bg-accent disabled:opacity-50'
      button.textContent = tab.title || tab.url || 'about:blank'; button.title = tab.url
      button.disabled = !connected; button.setAttribute('aria-current', String(tab.id === state?.activeTabId))
      button.onclick = () => control({ type: 'select-tab', tabId: tab.id })
      const close = document.createElement('button')
      close.className = 'size-6 shrink-0 rounded hover:bg-accent disabled:opacity-50'
      close.textContent = '×'; close.title = t().closeTab; close.setAttribute('aria-label', t().closeTab); close.disabled = !connected
      close.onclick = () => control({ type: 'close-tab', tabId: tab.id })
      group.append(button, close); tabs.append(group)
    }
  }
  layout()
}
function theme(themeVars: ExtensionThemeVars, mode: 'light' | 'dark') {
  for (const token of EXTENSION_THEME_TOKENS) {
    const value = themeVars?.[token]
    if (typeof value === 'string' && CSS.supports('color', value)) document.documentElement.style.setProperty(`--halo-${token}`, value)
    else document.documentElement.style.removeProperty(`--halo-${token}`)
  }
  document.documentElement.style.colorScheme = mode
}
function disconnect() {
  generation++; request?.abort(); request = undefined
  clearTimeout(reconnectTimer); reconnectTimer = undefined
  pendingTakeover = false; pendingFrames = []
  release(); send({ type: 'visible', visible: false })
  const old = socket; socket = undefined; old?.close()
  canInput = false; connected = false
  // A disconnected view must not leave a sign-in page painted as if it were live.
  context2d.clearRect(0, 0, screen.width, screen.height); empty.hidden = false; empty.textContent = t().waiting
  render()
}
function contextValue(): string {
  const context: ExtensionViewContext = { projectId: init!.context.projectId, ...(init!.context.sessionId && { sessionId: init!.context.sessionId }) }
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(context)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
async function connect() {
  disconnect()
  if (!init || stopped || document.hidden) return
  const current = generation
  request = new AbortController()
  reconnect.hidden = true; showError(''); element('mode').textContent = t().connecting
  try {
    const routing = contextValue()
    const body: BrowserViewRequest = { viewId: init.context.viewId }
    const response = await fetch('/api/ext/browser/view', { method: 'POST', credentials: 'same-origin', signal: request.signal,
      headers: { 'Content-Type': 'application/json', [EXTENSION_VIEW_CONTEXT_HEADER]: routing }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error('view-unavailable')
    const view = await response.json() as BrowserViewResponse
    if (current !== generation) return
    if (typeof view.viewId !== 'string' || !view.state?.viewport) throw new Error('invalid-view')
    state = view.state
    const url = new URL('/api/ext/browser/stream', window.location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('viewId', view.viewId); url.searchParams.set(EXTENSION_VIEW_CONTEXT_QUERY, routing)
    const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; socket = ws
    ws.onopen = () => { if (socket !== ws) return; connected = true; send({ type: 'subscribe', protocol: BROWSER_PROTOCOL_VERSION }); render() }
    ws.onmessage = event => {
      if (socket !== ws) return
      if (event.data instanceof ArrayBuffer) { void draw(event.data, ws); return }
      try { receive(JSON.parse(event.data) as BrowserServerFrame) } catch { showError(t().failed); ws.close() }
    }
    ws.onclose = () => {
      if (socket !== ws) return
      disconnect(); reconnect.hidden = false
      // Reconnect only after transport loss, never poll backend state. Stop after five attempts until user/visibility activity.
      if (!document.hidden && !stopped && reconnectAttempts < 5) {
        reconnectTimer = setTimeout(() => { void connect() }, Math.min(1000 * 2 ** reconnectAttempts++, 16000))
      }
    }
    ws.onerror = () => { if (socket === ws) showError(t().failed) }
  } catch {
    if (current !== generation) return
    showError(t().failed); reconnect.hidden = false; render()
  }
}
async function draw(bytes: ArrayBuffer, ws: WebSocket) {
  if (bytes.byteLength <= BROWSER_FRAME_HEADER_BYTES) { showError(t().decode); ws.close(); return }
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(new Blob([bytes.slice(BROWSER_FRAME_HEADER_BYTES)], { type: 'image/jpeg' }))
    if (socket !== ws || document.hidden) return
    if (screen.width !== bitmap.width || screen.height !== bitmap.height) { screen.width = bitmap.width; screen.height = bitmap.height }
    context2d.drawImage(bitmap, 0, 0); empty.hidden = true
    send({ type: 'frame-ack', sequence: new DataView(bytes).getUint32(0, false) })
  } catch { if (socket === ws) { showError(t().decode); ws.close() } }
  finally { bitmap?.close() }
}
function receive(frame: BrowserServerFrame) {
  switch (frame.type) {
    case 'state':
      if (canInput && !frame.canInput) release()
      state = frame.state; canInput = connected && frame.canInput
      if (canInput && pendingTakeover) {
        pendingTakeover = false
        const frames = pendingFrames; pendingFrames = []; for (const queued of frames) send(queued)
      }
      reconnectAttempts = 0; render(); break
    case 'runtime':
      if (frame.runtime.status !== 'ready') { empty.textContent = frame.runtime.reason || frame.runtime.status; empty.hidden = false }
      break
    case 'error':
      if (pendingTakeover) { pendingTakeover = false; pendingFrames = []; release() }
      showError(frame.error.code === 'forbidden' ? t().forbidden : frame.error.message); break
    case 'operation':
      if (frame.operation.status === 'failed') showError(frame.operation.error.message)
      break
  }
}
for (const type of ['back', 'forward', 'reload', 'new-tab'] as const) element(type).onclick = () => {
  control({ type })
  if (type === 'new-tab') { address.value = ''; address.focus(); address.select() }
}
address.onkeydown = event => {
  if (event.key !== 'Enter' || event.isComposing) return
  event.preventDefault()
  const url = addressUrl(address.value)
  if (!url) { showError(t().invalidUrl); return }
  address.value = url; address.blur(); control({ type: 'navigate', url })
}
function closeInfo() { limits.hidden = true; info.setAttribute('aria-expanded', 'false') }
info.onclick = () => { limits.hidden = !limits.hidden; info.setAttribute('aria-expanded', String(!limits.hidden)) }
document.addEventListener('pointerdown', event => { if (!info.contains(event.target as Node) && !limits.contains(event.target as Node)) closeInfo() })
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeInfo() })
reconnect.onclick = () => { reconnectAttempts = 0; void connect() }
window.addEventListener('message', (event: MessageEvent<ExtensionHostFrame | ExtensionCanvasInitFrame>) => {
  if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.haloExt !== 1) return
  const frame = event.data
  if (frame.type === 'init') {
    if (frame.view !== 'canvas' || frame.protocol !== 1 || typeof frame.context?.projectId !== 'string' || !frame.context.projectId || typeof frame.context.viewId !== 'string') {
      disconnect(); init = undefined; showError(t().protocol); return
    }
    init = frame; lang = frame.lang === 'zh' ? 'zh' : 'en'; document.documentElement.lang = lang
    theme(frame.themeVars, frame.theme); reconnectAttempts = 0; void connect()
  } else if (frame.type === 'theme') theme(frame.themeVars, frame.theme)
  else if (frame.type === 'lang') { lang = frame.lang === 'zh' ? 'zh' : 'en'; document.documentElement.lang = lang; render() }
})
document.addEventListener('visibilitychange', () => { if (document.hidden) disconnect(); else { reconnectAttempts = 0; void connect() } })
window.addEventListener('pagehide', () => { stopped = true; disconnect() })
window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; void connect() } })
host({ haloExt: 1, type: 'ready', protocol: 1 })
