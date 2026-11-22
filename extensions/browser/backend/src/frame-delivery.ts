import { BROWSER_AGENT_FPS, BROWSER_USER_FPS, BROWSER_LIMITS } from './protocol.js'

export interface FramePeer { bufferedAmount: number; send(data: Buffer): void }
interface PeerState { outstanding: number | null; delivered: number; lastSentAt: number }
/** Latest-only per viewer, independent CDP ACK; no cadence assumption about capture. */
export class FrameDelivery {
  private peers = new Map<FramePeer, PeerState>()
  private latest?: Buffer
  private version = 0
  private sequence = 0
  private timer?: ReturnType<typeof setTimeout>
  private fps: 2 | 10 = BROWSER_AGENT_FPS
  private history = new WeakMap<FramePeer, PeerState>()
  add(peer: FramePeer) {
    if (this.peers.has(peer)) return
    const state = this.history.get(peer) ?? { outstanding: null, delivered: 0, lastSentAt: -Infinity }
    this.peers.set(peer, state); this.history.set(peer, state); this.schedule()
  }
  remove(peer: FramePeer) { this.peers.delete(peer); this.reschedule() }
  capture(jpeg: Buffer) {
    // An oversized encoded image cannot fit the fixed outbound budget; never
    // retain it and starve a still-deliverable last frame behind it.
    if (jpeg.length + 4 > BROWSER_LIMITS.viewerBufferedBytes) return false
    this.latest = jpeg; this.version++; this.schedule(); return true
  }
  mode(user: boolean) { this.fps = user ? BROWSER_USER_FPS : BROWSER_AGENT_FPS; this.reschedule() }
  ack(peer: FramePeer, sequence: number) {
    const state = this.peers.get(peer) ?? this.history.get(peer)
    if (state?.outstanding === sequence) { state.outstanding = null; this.schedule() }
  }
  private reschedule() { clearTimeout(this.timer); this.timer = undefined; this.schedule() }
  private schedule() {
    if (this.timer || !this.latest) return
    const candidates = [...this.peers].filter(([peer, state]) => state.outstanding === null && state.delivered !== this.version && peer.bufferedAmount + this.latest!.length + 4 <= BROWSER_LIMITS.viewerBufferedBytes)
    if (!candidates.length) return // ACK/send completion or a new capture retries retained latest state.
    const deadline = Math.min(...candidates.map(([, state]) => state.lastSentAt + 1000 / this.fps))
    this.timer = setTimeout(() => {
      this.timer = undefined
      const now = performance.now()
      for (const [peer, state] of this.peers) {
        if (!this.latest || state.outstanding !== null || state.delivered === this.version || now - state.lastSentAt < 1000 / this.fps || peer.bufferedAmount + this.latest.length + 4 > BROWSER_LIMITS.viewerBufferedBytes) continue
        const packet = Buffer.alloc(4 + this.latest.length)
        this.sequence = (this.sequence + 1) >>> 0
        packet.writeUInt32BE(this.sequence); this.latest.copy(packet, 4)
        state.outstanding = this.sequence; state.delivered = this.version; state.lastSentAt = performance.now()
        peer.send(packet)
      }
      this.schedule()
    }, Math.max(0, Math.ceil(deadline - performance.now())))
  }
  retry() { this.schedule() }
  clearFrame() { this.latest = undefined; clearTimeout(this.timer); this.timer = undefined }
  close() { clearTimeout(this.timer); this.timer = undefined; this.peers.clear(); this.latest = undefined }
}
