import { BROWSER_FRAME_HEADER_BYTES, BROWSER_PROTOCOL_VERSION, BROWSER_VIEWPORT,
  type BrowserServerFrame, type BrowserState, type BrowserViewerFrame, type BrowserViewRequest, type BrowserViewResponse } from '../backend/src/protocol.js'
import { EXTENSION_THEME_TOKENS, type ExtensionClientFrame, type ExtensionHostFrame,
  type ExtensionLang, type ExtensionThemeVars } from '../contracts/halo-core/extension-frames.js'
import { EXTENSION_VIEW_CONTEXT_HEADER, EXTENSION_VIEW_CONTEXT_QUERY,
  type ExtensionCanvasInitFrame, type ExtensionFocusChatFrame, type ExtensionViewContext } from '../contracts/halo-core/extension-notices.js'
import { fitViewport } from './geometry.js'
import { bindInput } from './input.js'

const labels = {
  en: {
    browser: 'Browser', takeover: 'Take over', chat: 'Back to chat', reconnect: 'Reconnect', waiting: 'Waiting for browser…',
    connecting: 'Connecting…', disconnected: 'Disconnected · read-only', hidden: 'Hidden · stream paused',
    watching: 'Read-only · watching', driving: 'You are driving', user: 'Read-only · user control',
    paused: 'Agent paused. When you finish, return to the same Halo chat and tell the agent what to do next.',
    watchHint: 'Read-only. Take over to interact; only one viewer can control this workspace’s browser at a time.',
    userHint: 'Agent paused. This viewer is read-only. Take over is available only when no other viewer holds input control.',
    limits: 'Runs on the Halo server · limitations',
    limitsText: 'Sign-ins are shared by later sessions in this workspace. Text paste is supported; clipboard copy, file upload/download management, audio/video calls, passkeys and native permission dialogs are not supported here.',
    textLimit: 'Text is too long. Paste at most 4,096 characters at a time.', clipboard: 'Remote clipboard copy/cut is not supported. Text paste is supported.',
    failed: 'Could not connect. Check that the backend is enabled and confirmed in Halo Settings, then reconnect.',
    forbidden: 'Input was not granted. Another viewer may hold control; this viewer remains read-only.',
    decode: 'Could not decode a browser frame. Reconnect to try again.', protocol: 'Open this view in Halo 2.4.0 or later from Canvas.',
  },
  zh: {
    browser: '浏览器', takeover: '接管', chat: '返回聊天', reconnect: '重新连接', waiting: '等待浏览器…',
    connecting: '连接中…', disconnected: '已断开 · 只读', hidden: '已隐藏 · 画面暂停',
    watching: '只读 · 观看中', driving: '你正在操作', user: '只读 · 用户控制中',
    paused: '智能体已暂停。完成后，请返回同一个 Halo 聊天，告诉智能体下一步做什么。',
    watchHint: '当前只读。点击接管后操作；同一工作区的浏览器同时只能由一个查看者控制。',
    userHint: '智能体已暂停。当前查看者为只读；其他查看者没有占用输入控制权时才能接管。',
    limits: '运行在 Halo 服务器上 · 使用限制',
    limitsText: '登录状态与此工作区后续会话共享。支持粘贴文本；不支持复制远程剪贴板、文件上传/下载管理、音视频通话、通行密钥和系统权限对话框。',
    textLimit: '文本太长，每次最多粘贴 4,096 个字符。', clipboard: '不支持远程剪贴板复制/剪切，支持粘贴文本。',
    failed: '连接失败。请在 Halo 设置中确认后端已启用并获准运行，然后重新连接。',
    forbidden: '未获得输入权限，可能有其他查看者正在操作。当前查看者仍为只读。',
    decode: '浏览器画面解码失败，请重新连接。', protocol: '请在 Halo 2.4.0 或更高版本的 Canvas 中打开。',
  },
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const screen = element<HTMLCanvasElement>('screen')
const surface = element<HTMLDivElement>('surface')
const input = element<HTMLTextAreaElement>('input')
const takeover = element<HTMLButtonElement>('takeover')
const chat = element<HTMLButtonElement>('chat')
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
let socket: WebSocket | undefined
let request: AbortController | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectAttempts = 0
let generation = 0
let stopped = false
let tabKey = ''
const t = () => labels[lang]
const host = (frame: ExtensionClientFrame | ExtensionFocusChatFrame) => window.parent.postMessage(frame, window.location.origin)
const send = (frame: BrowserViewerFrame) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)) }
const showError = (message: string) => { error.textContent = message; error.hidden = !message }
const viewport = () => state?.viewport ?? BROWSER_VIEWPORT
const release = bindInput(screen, input, viewport, () => canInput, event => send({ type: 'input', event }), key => showError(t()[key]))

function layout() {
  const fit = fitViewport(surface.clientWidth, surface.clientHeight, viewport())
  Object.assign(screen.style, { width: `${fit.width}px`, height: `${fit.height}px`, left: `${fit.left}px`, top: `${fit.top}px` })
  Object.assign(input.style, { left: `${fit.left}px`, top: `${fit.top}px` })
}
new ResizeObserver(layout).observe(surface)
function render() {
  for (const node of document.querySelectorAll<HTMLElement>('[data-label]')) node.textContent = t()[node.dataset.label as keyof typeof labels.en]
  takeover.textContent = t().takeover; chat.textContent = t().chat; reconnect.textContent = t().reconnect
  chat.disabled = !init?.context.sessionId
  takeover.disabled = !connected || canInput
  input.disabled = !canInput
  screen.setAttribute('aria-label', canInput ? t().driving : t().watching)
  screen.classList.toggle('cursor-not-allowed', !canInput)
  element('mode').textContent = !connected ? document.hidden ? t().hidden : t().disconnected
    : `${canInput ? t().driving : state?.control.driver === 'user' ? t().user : t().watching} · ${state?.control.fps ?? 0} fps`
  element('guidance').textContent = canInput ? t().paused : state?.control.driver === 'user' ? t().userHint : t().watchHint
  const key = JSON.stringify([state?.tabs, state?.activeTabId, canInput])
  if (key !== tabKey) {
    tabKey = key; tabs.replaceChildren()
    for (const tab of state?.tabs ?? []) {
      const button = document.createElement('button')
      button.className = 'max-w-64 shrink-0 truncate rounded px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-60 hover:bg-accent'
      button.classList.toggle('bg-accent', tab.id === state?.activeTabId)
      button.textContent = tab.title || tab.url || 'about:blank'; button.title = tab.url
      button.disabled = !canInput; button.setAttribute('aria-current', String(tab.id === state?.activeTabId))
      button.onclick = () => { if (canInput) { release(); send({ type: 'select-tab', tabId: tab.id }) } }
      tabs.append(button)
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
      state = frame.state; canInput = connected && frame.canInput; reconnectAttempts = 0; render(); break
    case 'runtime':
      if (frame.runtime.status !== 'ready') { empty.textContent = frame.runtime.reason || frame.runtime.status; empty.hidden = false }
      break
    case 'error': showError(frame.error.code === 'forbidden' ? t().forbidden : frame.error.message); break
    case 'operation':
      if (frame.operation.status === 'failed') showError(frame.operation.error.message)
      break
  }
}
takeover.onclick = () => { if (connected && !canInput) { showError(''); send({ type: 'takeover' }) } }
chat.onclick = () => { if (init?.context.sessionId) { release(); host({ haloExt: 1, type: 'focus-chat' }) } }
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
