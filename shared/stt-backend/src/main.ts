/**
 * On-device speech-to-text backend, built into each extension that uses it
 * (voice-input, htrans — one copy each, see ../README.md). Halo runs it as
 * that extension's own child process (manifest `backend.entry`), reached from
 * the iframe through `/api/ext/<id>/*`; it starts on the first request and
 * stops after 5 idle minutes — exiting is what gives the ~400 MB the speech
 * engine pins back to the OS.
 *
 *   WS /stream[?speakers=1]   PCM s16le mono 16 kHz in, `model` / `ready` /
 *                             `final` / `error` text frames out — the same
 *                             protocol as Halo's /api/stt/stream used to be.
 *
 * Contract with Halo (env): HALO_EXT_SOCKET = where to listen,
 * HALO_EXT_DATA_DIR = our data dir (models go to <dir>/models/), and
 * `process.send({ type: 'ready' })` once listening. Auth is Halo's: only
 * logged-in admin requests are forwarded here.
 *
 * Writes: only `$HALO_EXT_DATA_DIR/models/` (each file as `<name>.part`,
 * renamed once verified). Audio and text are never stored.
 *
 * Model files are fetched on start (Halo starts us once when the admin
 * confirms the backend, so installing + confirming starts the download, as
 * Halo's built-in STT did on install) and on every stream while not ready.
 * While a download runs with nobody watching we tell Halo `busy` so the idle
 * stop doesn't cut it off.
 *
 * The WS endpoint itself is stream.ts; this file is the process around it.
 * Ported from halo-agent packages/server/src/routes/stt-ws.ts.
 */
import fs from 'node:fs'
import { createSttModelManager, type SttModelStatus } from './models.js'
import { createSttEngine } from './engine.js'
import { createStreamServer } from './stream.js'

const socketPath = process.env.HALO_EXT_SOCKET
if (!socketPath) {
  console.error('HALO_EXT_SOCKET not set — this script is started by Halo')
  process.exit(1)
}

const models = createSttModelManager()
const engine = createSttEngine({ models })
const { server, wss } = createStreamServer({ models, engine })

try { fs.rmSync(socketPath, { force: true }) } catch { /* Windows named pipe */ }
server.listen(socketPath, () => {
  console.log(`listening (rss=${Math.round(process.memoryUsage().rss / 1048576)}MB)`)
  process.send?.({ type: 'ready' })
  // Hold Halo's idle stop off while the models download (busy is cleared on
  // any end state: ready, error, or close()).
  let busy = false
  const hold = (s: SttModelStatus) => {
    const next = s.state === 'downloading'
    if (next !== busy) { busy = next; process.send?.({ type: 'busy', busy }) }
  }
  models.subscribe(hold)
  void models.ensure()
  hold(models.status())
})

function shutdown(): void {
  // Stop a download in progress; its .part resumes on the next start.
  models.close()
  for (const client of wss.clients) client.close(1001, 'Backend stopping')
  wss.close()
  server.close()
  setTimeout(() => process.exit(0), 200).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
