/**
 * Browser extension v1 wire contract. No runtime code or platform dependencies.
 * Generic access/notice/Canvas types live in halo-core/protocol/extension-notices.ts.
 * All browser IDs are opaque, workspace-bound IDs, never paths or authority.
 */
export const BROWSER_PROTOCOL_VERSION = 1
export const BROWSER_AGENT_FPS = 2
export const BROWSER_USER_FPS = 10
export const BROWSER_VIEWPORT = { width: 1280, height: 800 } as const
export const BROWSER_JPEG_QUALITY = 70
/** Binary frame = uint32 BE sequence + JPEG, not JSON/base64. */
export const BROWSER_FRAME_HEADER_BYTES = 4
export const BROWSER_LIMITS = {
  inputTextChars: 4096,
  pageTextChars: 20000,
  snapshotChars: 20000,
  screenshotBytes: 10 * 1024 * 1024,
  viewerBufferedBytes: 512 * 1024,
  commandTimeoutMs: 30000,
  contextCloseTimeoutMs: 3000,
  idleLeaseMs: 5 * 60 * 1000,
  handoffTimeoutMs: 30 * 60 * 1000,
} as const

export type BrowserDriver = 'agent' | 'user' | 'idle'
/** Zero only when capture is suspended/no visible viewer; no user-configured rate. */
export type BrowserFrameRate = 0 | typeof BROWSER_AGENT_FPS | typeof BROWSER_USER_FPS
export type BrowserControl =
  | { driver: 'agent'; ownerSessionId: string; fps: 0 | typeof BROWSER_AGENT_FPS }
  | { driver: 'user'; ownerSessionId: string | null; fps: 0 | typeof BROWSER_USER_FPS }
  | { driver: 'idle'; ownerSessionId: null; fps: 0 | typeof BROWSER_AGENT_FPS }
export interface BrowserViewport { width: number; height: number }
export interface BrowserTab { id: string; title: string; url: string }
export interface BrowserState {
  viewId: string
  control: BrowserControl
  tabs: BrowserTab[]
  activeTabId: string | null
  viewport: BrowserViewport
}
export type BrowserRuntimeStatus = 'starting' | 'downloading' | 'ready' | 'unavailable'
export interface BrowserRuntimeInfo {
  protocol: typeof BROWSER_PROTOCOL_VERSION
  status: BrowserRuntimeStatus
  browserVersion?: string
  reason?: string
}

/** Integer bitmask: Alt=1, Control=2, Meta=4, Shift=8. No lock/OS automation. */
export type BrowserModifiers = number
export type BrowserPointerButton = 'none' | 'left' | 'middle' | 'right'
export type BrowserInputEvent =
  | { kind: 'pointer'; event: 'move' | 'down' | 'up'; x: number; y: number; button: BrowserPointerButton; buttons: number; clickCount: number; modifiers: BrowserModifiers }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: BrowserModifiers }
  | { kind: 'key'; event: 'down' | 'up'; key: string; code: string; keyCode: number; modifiers: BrowserModifiers }
  | { kind: 'text'; text: string }
  | { kind: 'release-all' }
/** Coordinates are target CSS pixels, after undoing viewer scale/letterboxing. */
export type BrowserViewerFrame =
  | { type: 'subscribe'; protocol: typeof BROWSER_PROTOCOL_VERSION; tabId?: string }
  | { type: 'frame-ack'; sequence: number }
  | { type: 'takeover' }
  | { type: 'input'; event: BrowserInputEvent }
  | { type: 'select-tab'; tabId: string }
  | { type: 'navigate'; url: string }
  | { type: 'back' } | { type: 'forward' } | { type: 'reload' } | { type: 'new-tab' }
  | { type: 'close-tab'; tabId: string }
  | { type: 'visible'; visible: boolean }
/** No "done" or "resume" viewer frame: user completion is a Halo chat message. */
export type BrowserServerFrame =
  | { type: 'state'; state: BrowserState; canInput: boolean }
  | { type: 'runtime'; runtime: BrowserRuntimeInfo }
  | { type: 'operation'; operation: BrowserOperation }
  | { type: 'error'; error: BrowserError }

export type BrowserErrorCode =
  | 'invalid-request' | 'unauthorized' | 'forbidden' | 'unavailable'
  | 'not-found' | 'stale-ref' | 'timeout' | 'operation-failed'
export interface BrowserError {
  code: BrowserErrorCode
  /** Allowlisted/redacted message, never a raw Playwright/OS exception. */
  message: string
}
export interface BrowserSourceRef {
  /** Stable selection ID accepted verbatim by CLI --from. */
  id: string
  browser: string
  profile: string
}
/** Metadata only. Cookie names/values and decryption keys are never wire fields. */
export interface SigninSource extends BrowserSourceRef {
  count: number | null
  newestExpiry: string | null
  available: boolean
  reason: string
}
export type SigninImportResult =
  | { status: 'imported'; count: number; from: BrowserSourceRef }
  | { status: 'waiting-for-user' }
  | { status: 'unavailable'; reason: string }
  | { status: 'cancelled' }

export interface BrowserPageRead {
  tabId: string
  url: string
  title: string
  text: string
  ariaSnapshot: string
  /** Refs expire on navigation/re-read; never arbitrary CSS or JS. */
  snapshotId: string
  refs: Array<{ id: string; role: string; name: string }>
  truncated: boolean
}
export interface BrowserElementRef { snapshotId: string; ref: string }
export interface BrowserScreenshot {
  artifactId: string
  mimeType: 'image/png'
  bytes: number
  width: number
  height: number
}
export type BrowserActionResult = { status: 'ok' }
export interface BrowserCommandArgs {
  open: { url: string }
  read: Record<string, never>
  click: BrowserElementRef
  type: BrowserElementRef & { text: string }
  press: { key: string }
  scroll: { dx: number; dy: number }
  screenshot: Record<string, never>
  tabs: Record<string, never>
  'select-tab': { tabId: string }
  handoff: { reason?: string }
  'close-tab': { tabId: string }
  'signin-sources': { site: string }
  'signin-import': { site: string; from?: string }
}
export interface BrowserCommandResults {
  open: { viewId: string; tab: BrowserTab }
  read: BrowserPageRead
  click: BrowserActionResult
  type: BrowserActionResult
  press: BrowserActionResult
  scroll: BrowserActionResult
  screenshot: BrowserScreenshot
  tabs: { tabs: BrowserTab[]; activeTabId: string | null }
  'select-tab': BrowserActionResult
  handoff: { status: 'waiting-for-user' }
  'close-tab': BrowserActionResult
  'signin-sources': SigninSource[]
  'signin-import': SigninImportResult
}
export type BrowserCommandName = keyof BrowserCommandArgs
export const isReadCommand = (op: BrowserCommandName) => ['read', 'tabs', 'screenshot'].includes(op)
/** POST /command. Session identity comes only from X-Halo-Caller. */
export type BrowserCommandRequest<K extends BrowserCommandName = BrowserCommandName> = {
  [Op in K]: { id: string; op: Op; args: BrowserCommandArgs[Op] }
}[K]
/** Generic transport wrapper; CLI unwraps result, preserving sign-in status shapes. */
export type BrowserCommandResponse<K extends BrowserCommandName = BrowserCommandName> = {
  [Op in K]:
    | { id: string; op: Op; ok: true; result: BrowserCommandResults[Op] }
    | { id: string; op: Op; ok: true; status: 'running' }
    | { id: string; op: Op; ok: false; error: BrowserError }
    | { id: string; op: Op; ok: false; status: 'busy'; ownerSessionId: string }
    | { id: string; op: Op; ok: false; status: 'waiting-for-user' }
}[K]
export type BrowserOperationStatus = 'running' | 'waiting-for-user' | 'completed' | 'cancelled' | 'failed'
/** Operation id is the request id; GET /operations/:id is one-shot, never polling. */
export type BrowserOperation =
  | { id: string; op: BrowserCommandName; status: 'running' | 'waiting-for-user' }
  | { id: string; status: 'completed'; response: Exclude<BrowserCommandResponse, { status: 'running' }> }
  | { id: string; op: BrowserCommandName; status: 'cancelled' }
  | { id: string; op: BrowserCommandName; status: 'failed'; error: BrowserError }
/** POST /view: context is the proxy-validated header/query, not a body workspace. */
export interface BrowserViewRequest { viewId?: string }
export interface BrowserViewResponse { viewId: string; state: BrowserState }
