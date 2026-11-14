/**
 * The `/stream` WS endpoint — what main.ts serves on Halo's socket. Split out
 * of main.ts so tests can run it with stub models / engine (main.ts only
 * wires env, listen, busy and shutdown around it).
 *
 *   WS /stream[?speakers=1]   PCM s16le mono 16 kHz in, `model` / `ready` /
 *                             `final` / `error` text frames out.
 *
 * Ported from halo-agent packages/server/src/routes/stt-ws.ts.
 */
import http, { type IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { SttModelManager, SttModelStatus } from './models.js'
import { SttError, type SttEngine, type SttErrorCode, type SttStream } from './engine.js'

/** Per-frame cap. Clients send ~100–250 ms of PCM (3–8 KB) per frame. */
export const MAX_FRAME_BYTES = 1024 * 1024

export function createStreamServer(deps: { models: Pick<SttModelManager, 'status' | 'ensure' | 'subscribe'>; engine: SttEngine }): { server: http.Server; wss: WebSocketServer } {
  const { models, engine } = deps
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
    const speakers = q.get('speakers') === '1'
    const openedAt = Date.now()
    let closed = false
    let failed = false
    let ended = false
    let stream: SttStream | null = null
    let unsubscribe: (() => void) | null = null

    ws.on('error', (err) => { console.log(`client error: ${err.message}`) })

    const send = (frame: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }
    const fail = (code: SttErrorCode, message: string) => {
      if (failed || closed) return
      failed = true
      console.log(`stream error code=${code}`)
      send({ type: 'error', code, message })
      ws.close(1011, code)
    }

    async function startEngine(): Promise<void> {
      try {
        await engine.load({ speakers })
        if (closed || failed || ended) return
        stream = engine.open({
          // Recognized text goes to the client only — never to the log.
          onFinal: (f) => send({ type: 'final', ...f }),
          onError: (err) => fail(err.code, err.message),
        }, { speakers })
      } catch (err) {
        if (err instanceof SttError) fail(err.code, err.message)
        else fail('io', err instanceof Error ? err.message : String(err))
        return
      }
      if (closed || failed) return
      send({ type: 'ready' })
    }

    const onModel = (s: SttModelStatus) => {
      if (closed || failed) return
      send({ type: 'model', ...s })
      if (s.state === 'ready' || s.state === 'error') {
        unsubscribe?.()
        unsubscribe = null
      }
      if (s.state === 'ready') void startEngine()
      else if (s.state === 'error') fail('model', s.message ?? 'model download failed')
    }

    console.log(`stream open${speakers ? ' speakers=1' : ''}`)

    ws.on('message', (data, isBinary) => {
      if (ended || failed) return
      if (isBinary) {
        if (!stream) return // before `ready`: dropped
        stream.write(Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data as ArrayBuffer)]))
        return
      }
      let msg: unknown
      try { msg = JSON.parse(data.toString()) } catch { msg = null }
      if ((msg as { type?: unknown } | null)?.type !== 'end') {
        fail('bad-request', 'expected binary PCM or {"type":"end"}')
        return
      }
      ended = true
      if (!stream) { ws.close(1000); return }
      void stream.end().then(() => { if (!closed && !failed) ws.close(1000) })
    })

    ws.on('close', () => {
      closed = true
      unsubscribe?.()
      unsubscribe = null
      stream?.abort()
      const st = stream?.stats()
      console.log(`stream closed after ${((Date.now() - openedAt) / 1000).toFixed(1)}s${st ? ` segments=${st.segments} audio=${st.audioSeconds.toFixed(1)}s${st.speakers !== undefined ? ` speakers=${st.speakers}` : ''}` : ''} rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`)
    })

    const initial = models.status()
    if (initial.state === 'ready') {
      onModel(initial)
      return
    }
    let pushed = false
    unsubscribe = models.subscribe((s) => { pushed = true; onModel(s) })
    void models.ensure()
    if (!pushed) onModel(models.status())
  })

  const server = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"error":"Not found"}')
  })
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/stream') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  return { server, wss }
}
