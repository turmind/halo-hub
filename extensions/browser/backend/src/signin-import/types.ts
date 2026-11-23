import type { CDPSession } from 'playwright'
export type { SigninImportResult, SigninSource, BrowserSourceRef } from '../protocol.js'
export type { SigninHost, SigninService } from '../signin-service.js'

declare const send: CDPSession['send']
export type ImportCookie = NonNullable<Parameters<typeof send<'Network.setCookies'>>[1]>['cookies'][number]
export interface Source {
  id: string
  browser: string
  profile: string
  family: 'chromium' | 'firefox' | 'safari'
  root: string
  file: string
  service?: string
  account?: string
  application?: string
  unavailable?: Reason
}
export interface Machine {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
}
export const reasons = {
  site: 'Enter an explicit hostname or HTTP(S) URL, not a public suffix, wildcard or URL with credentials.',
  missing: 'No matching sign-in sources on this Halo server. Sign in inside Browser Canvas.',
  choose: 'Several sources match. Choose one source with --from; accounts are never merged.',
  changed: 'The source changed after approval. Review the sources and approve a new import.',
  privacy: 'Reading {browser} data was denied (permission error) — on macOS this is usually privacy protection. Give Halo Full Disk Access (System Settings → Privacy & Security → Full Disk Access; add Halo from Applications and make sure it is switched on), then quit Halo completely (Cmd+Q) and reopen it. If Halo was started from a terminal, grant that terminal app instead.',
  locked: 'Cannot read this browser store. Close that browser and retry (closing can lose session cookies), or sign in inside Browser Canvas.',
  unreadable: 'Cannot read this browser store; sign in inside Browser Canvas instead.',
  keychain: "macOS Keychain access to '{service}' was denied; retry and click Allow (or Always Allow).",
  format: 'This store format or cookie attributes cannot be copied faithfully. Sign in inside Browser Canvas.',
  appBound: 'This browser restricts its sign-in to its own application (Windows app-bound storage). Sign in inside Browser Canvas.',
  key: 'The browser storage key is unavailable or access was denied. Sign in inside Browser Canvas.',
  wallet: 'The desktop keyring is unavailable or locked for this Halo server user. Sign in inside Browser Canvas.',
  scope: 'This profile is outside the standard browser locations supported by this version.',
  activeWorkers: 'This target has active background workers. Close those tabs or sign in inside Browser Canvas before importing.',
  cancelled: 'Import cancelled before mutation or after confirmed rollback and checkpoint.',
  target: 'Import failed; affected cookies were restored. No unrelated cookies were cleared.',
  uncertain: 'Import or checkpoint failed and target state is uncertain. Inspect Browser Canvas before continuing.',
} as const
export type Reason = keyof typeof reasons
export class SigninFault extends Error {
  constructor(readonly reason: Reason, details: { browser?: string; service?: string; workers?: string[] } = {}) {
    super(reasons[reason].replace('{browser}', label(details.browser, 'browser')).replace('{service}', label(details.service, 'Browser Safe Storage')) + (reason === 'activeWorkers' && details.workers?.length ? '\n' + details.workers.slice(0, 5).join('\n') + (details.workers.length > 5 ? '\n…' : '') : ''))
    this.name = 'SigninFault'
  }
}
export function readFailure(error: unknown, platform: NodeJS.Platform, browser: string) {
  const { code, errcode } = (error ?? {}) as { code?: string; errcode?: number }
  const reason = platform === 'darwin' && (code === 'EPERM' || code === 'EACCES') ? 'privacy'
    : (platform === 'win32' && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) || (typeof errcode === 'number' && [5, 6].includes(errcode & 0xff)) ? 'locked' : 'unreadable'
  return new SigninFault(reason, { browser })
}
export function check(signal: AbortSignal) { if (signal.aborted) throw new SigninFault('key') }
export function publicReason(error: unknown) { return error instanceof SigninFault ? error.message : reasons.format }
export function label(value: unknown, fallback: string) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) || fallback : fallback
}
