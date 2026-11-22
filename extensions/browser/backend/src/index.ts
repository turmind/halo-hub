import { BrowserBackend } from './backend.js'
import type { ExtensionBackendHostMessage } from '../../contracts/halo-core/extension-notices.js'
import { killOwnedBrowsers } from './lifecycle.js'

if (process.platform !== 'win32') process.umask(0o077)
const socket = process.env.HALO_EXT_SOCKET
const dataDir = process.env.HALO_EXT_DATA_DIR
if (!socket || !dataDir || !process.send) throw new Error('Browser backend requires the Halo private socket and IPC environment.')
const backend = new BrowserBackend({ dataDir, send: message => { if (process.connected) process.send?.(message) } })
process.on('message', message => backend.receive(message as ExtensionBackendHostMessage))
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  const timer = setTimeout(() => { killOwnedBrowsers(); process.exit(0) }, 4000)
  try { await backend.close() } finally { clearTimeout(timer); killOwnedBrowsers(); process.exit(0) }
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
process.on('disconnect', () => { killOwnedBrowsers(); void stop() })
void backend.listen(socket).catch(() => { console.error('[Browser] Private socket initialization failed.'); process.exit(1) })
