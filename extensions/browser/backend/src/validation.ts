import { isAbsolute, win32 } from 'node:path'
import type { IncomingHttpHeaders } from 'node:http'
import { EXTENSION_CALLER_HEADER, type ExtensionCaller } from '../../contracts/halo-core/extension-notices.js'
import { BROWSER_LIMITS, type BrowserCommandRequest } from './protocol.js'
import { BrowserFault } from './errors.js'

export const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
export function callerFrom(headers: IncomingHttpHeaders): ExtensionCaller {
  try {
    const raw = headers[EXTENSION_CALLER_HEADER]
    if (typeof raw !== 'string' || raw.length > 16384) throw new Error()
    const caller = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as ExtensionCaller
    if (!['session', 'admin'].includes(caller.kind) || !opaque(caller.bindingId) || typeof caller.projectId !== 'string' || !(isAbsolute(caller.projectId) || win32.isAbsolute(caller.projectId)) || caller.projectId.length > 4096 || caller.userTurnId !== null && !opaque(caller.userTurnId)) throw new Error()
    if (caller.kind === 'session' && (!opaque(caller.sessionId) || !opaque(caller.rootSessionId) || !text(caller.agentId, 128))) throw new Error()
    if (caller.kind === 'admin' && caller.sessionId !== undefined && !opaque(caller.sessionId)) throw new Error()
    return caller
  } catch { throw new BrowserFault('unauthorized') }
}
export function commandFrom(value: unknown): BrowserCommandRequest {
  if (!value || typeof value !== 'object') throw new BrowserFault('invalid-request')
  const { id, op, args } = value as Record<string, unknown>
  if (!opaque(id) || typeof op !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new BrowserFault('invalid-request')
  const a = args as Record<string, unknown>
  let valid = false
  switch (op) {
    case 'open':
      if (text(a.url, 8192)) { try { const url = new URL(a.url); valid = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { /* invalid URL */ } } break
    case 'read': case 'tabs': case 'screenshot': case 'control.resume': valid = Object.keys(a).length === 0; break
    case 'click': case 'type': valid = opaque(a.snapshotId) && opaque(a.ref) && (op === 'click' || text(a.text, BROWSER_LIMITS.inputTextChars)); break
    case 'press': valid = text(a.key, 100) && /^[A-Za-z0-9+_ .,:;!?@#$%^&*()\[\]{}<>\/\\=\-]+$/.test(a.key); break
    case 'scroll': valid = [a.dx, a.dy].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000); break
    case 'select-tab': valid = opaque(a.tabId); break
    case 'handoff': valid = a.reason === undefined || text(a.reason, 1000); break
    case 'signin-sources': case 'signin-import': valid = text(a.site, 2048) && a.site.length > 0 && (a.from === undefined || text(a.from, 512)); break
  }
  if (!valid) throw new BrowserFault('invalid-request')
  return value as BrowserCommandRequest
}
