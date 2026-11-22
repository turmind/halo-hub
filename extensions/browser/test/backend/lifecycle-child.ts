import { fixtureLauncher } from './fixtures.js'
const context = await fixtureLauncher(process.argv[2], new AbortController().signal, () => {})
const cdp = await context.browser()!.newBrowserCDPSession()
const info = await cdp.send('SystemInfo.getProcessInfo')
await cdp.detach()
process.send?.({ pid: info.processInfo.find(item => item.type === 'browser')!.id })
// Simulates Halo's preload, which registered before backend code.
process.on('disconnect', () => process.exit(0))
