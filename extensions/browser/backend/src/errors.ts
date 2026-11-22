import type { BrowserError, BrowserErrorCode } from './protocol.js'

const messages: Record<BrowserErrorCode, string> = {
  'invalid-request': 'Invalid browser request.', unauthorized: 'A validated Halo caller is required.',
  forbidden: 'This caller does not control this browser.', unavailable: 'Browser unavailable. Check browser prerequisites on the Halo server.',
  'not-found': 'Browser resource not found or expired.', 'stale-ref': 'Page snapshot changed. Read the page again.',
  timeout: 'Browser action timed out.', 'operation-failed': 'Browser operation failed. No credential details are included.',
}
export class BrowserFault extends Error {
  constructor(readonly code: BrowserErrorCode) { super(messages[code]) }
}
export function publicError(error: unknown): BrowserError {
  const code = error instanceof BrowserFault ? error.code : 'operation-failed'
  return { code, message: messages[code] }
}
export function checkSignal(signal: AbortSignal) { if (signal.aborted) throw new BrowserFault('forbidden') }
export function safeUrl(value: string): string {
  try { const url = new URL(value); url.username = ''; url.password = ''; return url.href } catch { return 'about:blank' }
}
