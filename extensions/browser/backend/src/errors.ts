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
export class BrowserLaunchFault extends BrowserFault {
  constructor(error: unknown) {
    super('unavailable')
    const detail = error instanceof Error ? error.message : ''
    const category = /error while loading shared libraries|Host system is missing dependencies/i.test(detail) ? 'missing-libraries'
      : /SIGTRAP|SIGSEGV|SIGABRT|chrome_crashpad_handler: --database is required|browser.*crash/i.test(detail) ? 'crashed'
      : (error instanceof Error && error.name === 'TimeoutError') || /Timeout \d+ms exceeded|timed out/i.test(detail) ? 'timeout'
      : /process did exit|exitCode=|Target page, context or browser has been closed/i.test(detail) ? 'exited' : 'unknown'
    this.message = category === 'missing-libraries'
      ? 'Browser failed to start (missing-libraries). Install the Playwright Chromium shared-library prerequisites on the Halo server; no administrator install is performed.'
      : `Browser failed to start (${category}). Check the backend logs on the Halo server.`
  }
}
export function publicError(error: unknown): BrowserError {
  const code = error instanceof BrowserFault ? error.code : 'operation-failed'
  return { code, message: error instanceof BrowserLaunchFault ? error.message : messages[code] }
}
export function checkSignal(signal: AbortSignal) { if (signal.aborted) throw new BrowserFault('forbidden') }
export function safeUrl(value: string): string {
  try { const url = new URL(value); url.username = ''; url.password = ''; return url.href } catch { return 'about:blank' }
}
