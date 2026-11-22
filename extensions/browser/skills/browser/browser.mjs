#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { open, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// Transport errors are deliberately allowlisted: never serialize fetch errors,
// headers, the environment, or a remote HTML error page into a tool transcript.
class CliError extends Error {}
const fail = message => { throw new CliError(message) }
function access() {
  let entry
  try { entry = JSON.parse(process.env.HALO_EXT_BACKENDS ?? '{}').browser } catch { fail('Browser access is unavailable in this shell.') }
  if (!entry || typeof entry.url !== 'string' || typeof entry.accessKey !== 'string' || Date.parse(entry.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(entry.expiresAt))) fail('Browser access is unavailable or expired. Run a new eligible shell command.')
  let url
  try { url = new URL(entry.url) } catch { fail('Invalid browser endpoint.') }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/api/ext/browser')) fail('Invalid browser endpoint.')
  return entry
}
async function limited(response, max) {
  if (!response.body) fail('Empty browser response.')
  const chunks = []; let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > max) fail('Browser response exceeded the output limit.')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
async function main() {
  const args = process.argv.slice(2)
  const command = args.shift()
  if (!command || command === '--help') {
    console.log('browser: open URL | read | click SNAPSHOT:REF | type SNAPSHOT:REF TEXT | press KEY | scroll DX DY | screenshot FILE | tabs | select-tab ID | handoff [REASON] | signin-sources SITE | signin-import SITE [--from SOURCE] | resume | status | operation ID')
    return
  }
  let op = command; let payload = {}; let file
  const exact = count => { if (args.length !== count) fail('Invalid command arguments. Use --help.') }
  switch (command) {
    case 'open': exact(1); payload = { url: args[0] }; break
    case 'read': case 'tabs': case 'status': exact(0); break
    case 'resume': exact(0); op = 'control.resume'; break
    case 'click': case 'type': {
      exact(command === 'click' ? 1 : 2)
      const ref = args[0].split(':')
      if (ref.length !== 2 || !ref.every(s => /^[A-Za-z0-9_-]{1,128}$/.test(s))) fail('Use the current snapshotId:ref from read; never a CSS selector.')
      payload = { snapshotId: ref[0], ref: ref[1], ...(command === 'type' ? { text: args[1] } : {}) }; break
    }
    case 'press': exact(1); payload = { key: args[0] }; break
    case 'scroll': exact(2); payload = { dx: Number(args[0]), dy: Number(args[1]) }; if (!Object.values(payload).every(Number.isFinite)) fail('Scroll offsets must be numbers.'); break
    case 'select-tab': exact(1); payload = { tabId: args[0] }; break
    case 'screenshot': exact(1); file = resolve(args[0]); break
    case 'handoff': if (args.length > 1) fail('Quote the handoff reason.'); payload = args[0] ? { reason: args[0] } : {}; break
    case 'signin-sources': exact(1); payload = { site: args[0] }; break
    case 'signin-import': if (args.length !== 1 && !(args.length === 3 && args[1] === '--from')) fail('Use signin-import SITE [--from SOURCE].'); payload = { site: args[0], ...(args[2] ? { from: args[2] } : {}) }; break
    case 'operation': exact(1); if (!/^[A-Za-z0-9_-]{1,128}$/.test(args[0])) fail('Invalid operation id.'); break
    default: fail('Unknown browser command. Use --help.')
  }
  const entry = access()
  const request = async (path, body, image = false) => {
    let response
    try { response = await fetch(entry.url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${entry.accessKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(35000), redirect: 'error' }) }
    catch { fail('Browser request failed or timed out. Check status from a new shell; do not retry mutations blindly.') }
    if (!response.ok) { await response.body?.cancel(); fail(`Browser request refused (HTTP ${response.status}).`) }
    const bytes = await limited(response, image ? 10 * 1024 * 1024 : 128 * 1024)
    if (image) {
      if (response.headers.get('content-type') !== 'image/png' || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) fail('Invalid screenshot response.')
      return bytes
    }
    try { return JSON.parse(bytes.toString('utf8')) } catch { fail('Invalid browser response.') }
  }
  const response = command === 'status' ? await request('/status') : command === 'operation' ? await request('/operations/' + args[0]) : await request('/command', { id: randomUUID(), op, args: payload })
  let output = response.ok === true && 'result' in response
    ? response.result?.status === 'waiting-for-user' ? { ...response.result, id: response.id } : response.result
    : response
  if (file && response.ok && response.result?.artifactId) {
    const bytes = await request('/artifacts/' + encodeURIComponent(response.result.artifactId), undefined, true)
    await mkdir(dirname(file), { recursive: true })
    const handle = await open(file, 'wx', 0o600)
    try { await handle.writeFile(bytes) } finally { await handle.close() }
    output = { ...response.result, file }
  }
  // Defense in depth for accidental reflected transport keys; cookie fields are
  // never part of the protocol, and server errors must be allowlisted there.
  console.log(JSON.stringify(output).split(entry.accessKey).join('[REDACTED]'))
}
main().catch(error => { console.error(error instanceof CliError ? error.message : 'Browser command failed. No credential details are included.'); process.exitCode = 1 })
