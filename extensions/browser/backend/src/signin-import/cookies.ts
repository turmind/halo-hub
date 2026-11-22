import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import type { StoreRead, StoreRow } from './store-reader.js'
import { matches, type SiteScope } from './site-scope.js'
import { SigninFault, type ImportCookie, type Machine, type Source } from './types.js'
import type { OsSecrets } from './os-secrets.js'

export function metadata(row: StoreRow, source: Source, scope: SiteScope): Omit<ImportCookie, 'name' | 'value'> {
  if (typeof row.host !== 'string' || !matches(row.host, scope) || typeof row.path !== 'string' || !row.path.startsWith('/') || /[\x00-\x1f\x7f]/.test(row.host + row.path)) throw new SigninFault('format')
  const chrome = source.family === 'chromium'
  const sameSites: Record<string, 'None' | 'Lax' | 'Strict' | undefined> = { '-1': undefined, '0': 'None', '1': 'Lax', '2': 'Strict' }
  const sameSite = sameSites[String(row.sameSite)]
  if (chrome ? ![-1n, 0n, 1n, 2n].includes(row.sameSite) : ![0n, 1n, 2n].includes(row.sameSite)) throw new SigninFault('format')
  // Firefox originAttributes encode containers/first-party isolation/partition ancestry differently.
  // No proven lossless conversion: refuse the site's source, never merge containers/unpartition.
  if (!chrome && row.attributes) throw new SigninFault('format')
  if (![row.secure, row.httpOnly, row.persistent].every(value => value === 0n || value === 1n)) throw new SigninFault('format')
  const expiry = chrome ? Number(row.expiry / 1000000n - 11644473600n) : Number(row.expiry)
  const cookie: Omit<ImportCookie, 'name' | 'value'> = { domain: row.host, path: row.path, secure: !!row.secure, httpOnly: !!row.httpOnly, ...(sameSite ? { sameSite } : {}), ...(row.persistent ? { expires: expiry } : {}) }
  if (row.persistent && (!Number.isFinite(expiry) || expiry <= Date.now() / 1000)) throw new SigninFault('changed')
  if (row.partition) {
    let url: URL
    try { url = new URL(row.partition) } catch { throw new SigninFault('format') }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== row.partition || ![0n, 1n].includes(row.ancestor)) throw new SigninFault('format')
    cookie.partitionKey = { topLevelSite: row.partition, hasCrossSiteAncestor: !!row.ancestor }
  }
  if (chrome && ![0n, 1n, 2n].includes(row.sourceScheme)) throw new SigninFault('format')
  if (chrome && row.sourceScheme !== 0n) cookie.sourceScheme = row.sourceScheme === 2n ? 'Secure' : 'NonSecure'
  if (row.sourcePort !== -1n && (row.sourcePort < 1n || row.sourcePort > 65535n)) throw new SigninFault('format')
  if (chrome) cookie.sourcePort = Number(row.sourcePort)
  return cookie
}
export function validateCookie(cookie: ImportCookie) {
  if (!cookie.name || /[\x00-\x20\x7f;=]/.test(cookie.name) || /[\x00-\x1f\x7f]/.test(cookie.value) || Buffer.byteLength(cookie.name + cookie.value) > 4096) throw new SigninFault('format')
  if (cookie.name.startsWith('__Secure-') && !cookie.secure || cookie.name.startsWith('__Host-') && (!cookie.secure || cookie.path !== '/' || cookie.domain?.startsWith('.')) || cookie.sameSite === 'None' && !cookie.secure || cookie.partitionKey && !cookie.secure) throw new SigninFault('format')
}
export function validateEnvelopes(store: StoreRead, machine: Machine) {
  // Fail the entire source before any secret access, not after partially decoding mixed rows.
  for (const row of store.rows) {
    const bytes = row.encrypted ?? new Uint8Array()
    const tag = Buffer.from(bytes.subarray(0, 3)).toString()
    if (tag === 'v20') throw new SigninFault('appBound')
    if (bytes.length && !['v10', 'v11'].includes(tag) && !(machine.platform === 'win32' && bytes[0] === 1 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0)) throw new SigninFault('format')
  }
}
export async function decodeStore(store: StoreRead, source: Source, scope: SiteScope, machine: Machine, secrets: OsSecrets): Promise<ImportCookie[]> {
  validateEnvelopes(store, machine)
  const cookies: ImportCookie[] = []
  for (const row of store.rows) {
    const fields = metadata(row, source, scope)
    let plain: Buffer | undefined
    const encrypted = Buffer.from(row.encrypted ?? [])
    try {
      if (!encrypted.length) plain = Buffer.from(row.value ?? '')
      else {
        const tag = encrypted.subarray(0, 3).toString()
        if (tag !== 'v10' && tag !== 'v11') plain = await secrets.dpapi(encrypted)
        else {
          const key = await secrets.chromiumKey(source, tag)
          if (machine.platform === 'win32') {
            if (encrypted.length < 31) throw new SigninFault('format')
            const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(3, 15)); decipher.setAuthTag(encrypted.subarray(-16))
            plain = Buffer.concat([decipher.update(encrypted.subarray(15, -16)), decipher.final()])
          } else {
            const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
            plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
          }
        }
        if (store.version >= 24) {
          const digest = createHash('sha256').update(row.host).digest()
          if (plain.length < 32 || !timingSafeEqual(digest, plain.subarray(0, 32))) throw new SigninFault('format')
          const value = Buffer.from(plain.subarray(32)); plain.fill(0); plain = value
        }
      }
      const value = new TextDecoder('utf-8', { fatal: true }).decode(plain)
      const cookie: ImportCookie = { ...fields, name: row.name!, value }
      validateCookie(cookie); cookies.push(cookie)
    } catch (error) {
      for (const cookie of cookies) cookie.value = ''
      if (error instanceof SigninFault) throw error
      throw new SigninFault('format')
    }
    finally { encrypted.fill(0); plain?.fill(0); row.encrypted?.fill(0); row.value = undefined }
  }
  return cookies
}
