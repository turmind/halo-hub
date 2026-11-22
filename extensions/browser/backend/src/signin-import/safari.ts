import { open } from 'node:fs/promises'
import type { Source } from './types.js'
import { SigninFault } from './types.js'
import { matches, type SiteScope } from './site-scope.js'

/** Header/domain/expiry reads only. Legacy binarycookies has no reliable SameSite/partition
 * metadata, so discovery reports counts but import is unavailable rather than weakening them. */
export async function safariMetadata(source: Source, scope: SiteScope) {
  const file = await open(source.file, 'r')
  try {
    const size = (await file.stat()).size
    const read = async (position: number, length: number) => {
      if (position < 0 || length < 0 || position + length > size || length > 1024 * 1024) throw new SigninFault('format')
      const buffer = Buffer.alloc(length)
      if ((await file.read(buffer, 0, length, position)).bytesRead !== length) throw new SigninFault('format')
      return buffer
    }
    const header = await read(0, 8)
    if (header.subarray(0, 4).toString() !== 'cook') throw new SigninFault('format')
    const pages = header.readUInt32BE(4)
    if (pages > 10000) throw new SigninFault('format')
    const sizes = await read(8, pages * 4)
    let position = 8 + pages * 4; let count = 0; let newest: number | null = null
    for (let i = 0; i < pages; i++) {
      const length = sizes.readUInt32BE(i * 4); const page = await read(position, 8)
      if (!page.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) throw new SigninFault('format')
      const n = page.readUInt32LE(4)
      if (n > 10000 || 8 + n * 4 > length) throw new SigninFault('format')
      const offsets = await read(position + 8, n * 4)
      for (let j = 0; j < n; j++) {
        const offset = offsets.readUInt32LE(j * 4)
        const record = await read(position + offset, 56)
        const recordSize = record.readUInt32LE(0); const hostOffset = record.readUInt32LE(16)
        // Bound the domain by the next field offset, never decode cookie name/value payloads.
        const next = [record.readUInt32LE(20), record.readUInt32LE(24), record.readUInt32LE(28), recordSize].filter(x => x > hostOffset).sort((a, b) => a - b)[0]
        if (offset + recordSize > length || hostOffset < 56 || !next || next - hostOffset > 256) throw new SigninFault('format')
        const domain = (await read(position + offset + hostOffset, next - hostOffset)).toString().split('\0')[0]
        const expiry = record.readDoubleLE(40) + 978307200
        if (!Number.isFinite(expiry)) throw new SigninFault('format')
        if (matches(domain, scope) && expiry > Date.now() / 1000) { count++; newest = Math.max(newest ?? 0, expiry) }
      }
      position += length
    }
    return { count, newestExpiry: newest === null ? null : new Date(newest * 1000).toISOString() }
  } finally { await file.close() }
}
