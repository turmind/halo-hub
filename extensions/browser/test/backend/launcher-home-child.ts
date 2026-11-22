import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { writeFile, stat } from 'node:fs/promises'
import { createBrowserLauncher } from '../../backend/src/browser-launcher.js'

const [dataDir, readonlyHome] = process.argv.slice(2)
assert.equal(process.env.HOME, readonlyHome)
await assert.rejects(writeFile(join(readonlyHome, 'must-not-write'), 'fixture'), { code: /EACCES|EROFS/ })
const site = createServer((_req, res) => { res.end('<title>Readonly home fixture</title>Browser ready') })
await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
const address = site.address(); assert.ok(address && typeof address !== 'string')
try {
  const context = await createBrowserLauncher(dataDir)(join(dataDir, 'profile'), new AbortController().signal, () => {})
  try {
    const page = context.pages()[0]
    await page.goto(`http://127.0.0.1:${address.port}`)
    assert.equal(await page.title(), 'Readonly home fixture')
    for (const name of ['home', 'config', 'cache', 'data']) assert.ok((await stat(join(dataDir, 'chromium-xdg', name))).isDirectory())
    assert.ok((await stat(join(dataDir, 'chromium-xdg/config/google-chrome-for-testing/Crash Reports'))).isDirectory())
    assert.ok((await stat(join(dataDir, 'chromium-xdg/data/pki/nssdb/cert9.db'))).isFile())
    assert.equal(process.env.HOME, readonlyHome) // Only the Chromium child environment changes; source discovery keeps the real HOME.
    console.log(JSON.stringify({ launched: true, version: context.browser()!.version(), homeUnchanged: true }))
  } finally { await context.close() }
} finally { await new Promise<void>(resolve => site.close(() => resolve())) }
