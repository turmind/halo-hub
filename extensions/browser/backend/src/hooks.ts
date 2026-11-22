import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ExtensionBackendHostMessage, ExtensionCaller, ExtensionNotice, ExtensionNoticeBackendMessage, ExtensionNoticeDecision } from '../../contracts/halo-core/extension-notices.js'
import { EXTENSION_NOTICE_LIMITS } from '../../contracts/halo-core/extension-notices.js'
import { BrowserFault } from './errors.js'

interface Pending {
  requestId: string; bindingId: string; generation?: string; decision?: ExtensionNoticeDecision
  finish: (decision: ExtensionNoticeDecision) => void; timer: ReturnType<typeof setTimeout>
}
export type IpcSend = (message: ExtensionNoticeBackendMessage | { type: 'ready' } | { type: 'busy'; busy: boolean }) => void
export class Hooks extends EventEmitter {
  private pending = new Map<string, Pending>()
  private busy = false
  constructor(readonly send: IpcSend) { super() }
  setBusy(busy: boolean) { if (busy !== this.busy) { this.busy = busy; this.send({ type: 'busy', busy }) } }
  receive(message: ExtensionBackendHostMessage) {
    if (message.type === 'halo:caller:updated' || message.type === 'halo:caller:revoked') {
      if (message.type === 'halo:caller:revoked') for (const [id, entry] of this.pending) if (entry.bindingId === message.bindingId) this.withdraw(id)
      this.emit('caller', message); return
    }
    if (message.type === 'halo:notice:accepted') {
      const entry = this.pending.get(message.id)
      if (entry?.requestId === message.requestId) entry.generation = message.generation
    } else if (message.type === 'halo:notice:error') {
      for (const entry of this.pending.values()) if (entry.requestId === message.requestId) entry.finish('withdrawn')
    } else if (message.type === 'halo:notice:result') {
      const entry = this.pending.get(message.id)
      if (entry?.generation === message.generation) entry.finish(message.decision)
    }
  }
  notice(caller: ExtensionCaller, notice: ExtensionNotice, signal: AbortSignal): Promise<ExtensionNoticeDecision> {
    if (signal.aborted) return Promise.resolve('withdrawn')
    if (notice.expiresInMs < EXTENSION_NOTICE_LIMITS.minTtlMs || notice.expiresInMs > EXTENSION_NOTICE_LIMITS.maxTtlMs || notice.message.length > EXTENSION_NOTICE_LIMITS.messageChars || this.pending.has(notice.id)) throw new BrowserFault('invalid-request')
    return new Promise(resolve => {
      const abort = () => this.withdraw(notice.id)
      const finish = (decision: ExtensionNoticeDecision) => {
        const entry = this.pending.get(notice.id)
        if (!entry) return
        clearTimeout(entry.timer); this.pending.delete(notice.id); signal.removeEventListener('abort', abort); resolve(decision)
      }
      const entry: Pending = { requestId: randomUUID(), bindingId: caller.bindingId, finish, timer: setTimeout(() => this.withdraw(notice.id, 'expired'), notice.expiresInMs) }
      this.pending.set(notice.id, entry)
      signal.addEventListener('abort', abort, { once: true })
      this.send({ type: 'halo:notice', requestId: entry.requestId, bindingId: caller.bindingId, notice })
    })
  }
  private opens = new Map<string, string>()
  open(caller: ExtensionCaller, viewId: string, message: string, signal: AbortSignal) {
    const key = JSON.stringify([caller.projectId, caller.sessionId, viewId])
    const previous = this.opens.get(key)
    if (previous) this.withdraw(previous)
    const id = randomUUID(); this.opens.set(key, id)
    void this.notice(caller, { id, message, level: 'info', expiresInMs: 30 * 60 * 1000, action: { type: 'open-canvas', viewId, title: 'Browser' } }, signal).finally(() => { if (this.opens.get(key) === id) this.opens.delete(key) })
  }
  private withdraw(id: string, decision: ExtensionNoticeDecision = 'withdrawn') {
    this.send({ type: 'halo:notice:withdraw', id }); this.pending.get(id)?.finish(decision)
  }
  close() { for (const id of this.pending.keys()) this.withdraw(id); this.removeAllListeners() }
}
