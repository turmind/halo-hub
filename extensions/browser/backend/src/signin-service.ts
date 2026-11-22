import type { BrowserContext } from 'playwright'
import type { ExtensionCaller, ExtensionNotice, ExtensionNoticeDecision } from '../../contracts/halo-core/extension-notices.js'
import type { SigninImportResult, SigninSource } from './protocol.js'

/** Implemented by signin-import/index.ts; the backend owns operation/lease lifetime. */
export interface SigninService {
  sources(site: string): Promise<SigninSource[]>
  import(site: string, from: string | undefined): Promise<SigninImportResult>
  dispose(): Promise<void>
}

/** Valid only inside withCommit, bound to its original context; cleanup/checkpoint ignore request abort. */
export interface SigninCommit {
  withContext<T>(work: (context: BrowserContext) => Promise<T>): Promise<T>
  cleanup<T>(work: (context: BrowserContext) => Promise<T>): Promise<T>
  checkpoint(): Promise<void>
}
/** Bound by the backend, never by a caller-supplied operation or profile path. */
export interface SigninHost {
  caller: ExtensionCaller
  signal: AbortSignal
  withCommit<T>(work: (target: SigninCommit) => Promise<T>): Promise<T>
  confirm(notice: ExtensionNotice): Promise<ExtensionNoticeDecision>
}
export type SigninServiceFactory = (host: SigninHost) => SigninService
