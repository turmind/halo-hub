import { spawn } from 'node:child_process'
import type { BrowserContext } from 'playwright'

const browserPids = new Set<number>()
const contextPids = new WeakMap<BrowserContext, number>()
let installed = false
/** Playwright creates its own detached process group on POSIX. The Halo preload
 * exits immediately on disconnect, so async close alone cannot clean up children. */
export async function trackBrowser(context: BrowserContext) {
  const browser = context.browser()
  if (!browser) throw new Error('Missing browser process')
  const cdp = await browser.newBrowserCDPSession()
  try {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
    const pid = processInfo.find(info => info.type === 'browser')?.id
    if (!pid || pid === process.pid) throw new Error('Missing browser pid')
    browserPids.add(pid); contextPids.set(context, pid)
    context.once('close', () => { browserPids.delete(pid); contextPids.delete(context) })
  } finally { await cdp.detach() }
  if (!installed) { installed = true; process.once('exit', killOwnedBrowsers) }
}
function killPid(pid: number) {
  if (!browserPids.delete(pid)) return
  try {
    if (process.platform === 'win32') {
      // Spawn starts taskkill even in an exit handler; detached cleanup must not block the shutdown budget.
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', detached: true, windowsHide: true })
      child.on('error', () => { /* The browser may already have exited; cleanup is best-effort. */ }); child.unref()
    } else process.kill(-pid, 'SIGKILL')
  } catch { /* A browser may already have exited. Never target an unowned process. */ }
}
export function killContext(context: BrowserContext) {
  const pid = contextPids.get(context)
  if (pid) killPid(pid)
}
export function trackChildProcess(pid: number): () => void {
  browserPids.add(pid)
  if (!installed) { installed = true; process.once('exit', killOwnedBrowsers) }
  return () => { browserPids.delete(pid) }
}
export function killOwnedBrowsers() {
  for (const pid of browserPids) killPid(pid)
}
