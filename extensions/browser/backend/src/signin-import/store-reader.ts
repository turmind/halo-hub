import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import type { SiteScope } from './site-scope.js'
import { readFailure, SigninFault, type Source } from './types.js'

export interface StoreRow {
  host: string; path: string; expiry: bigint; persistent: bigint; secure: bigint; httpOnly: bigint; sameSite: bigint
  partition: string; ancestor: bigint; attributes: string; sourceScheme: bigint; sourcePort: bigint
  name?: string; value?: string; encrypted?: Uint8Array
}
export interface StoreRead { version: number; rows: StoreRow[]; fingerprint: string }
// Self-contained JS worker survives the extension's CJS bundle; SQLite never blocks the backend loop.
// No temp snapshots: read-only transaction includes WAL; only SQLite BUSY/LOCKED advises closing.
const reader = String.raw`
const { parentPort, workerData: d } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
try {
  db = new DatabaseSync(d.file, { readOnly: true, timeout: 1000 });
  db.exec('PRAGMA query_only=ON; BEGIN');
  const chrome = d.family === 'chromium';
  const table = chrome ? 'cookies' : 'moz_cookies';
  const host = chrome ? 'host_key' : 'host';
  const columns = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(r => r.name));
  const version = chrome ? Number(db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value) : Number(db.prepare('PRAGMA user_version').get().user_version);
  if (chrome ? !Number.isInteger(version) || version < 1 || version > 24 : version < 10 || version > 16) throw 'format';
  const required = chrome ? ['host_key','path','expires_utc','is_persistent','is_secure','is_httponly','samesite'] : ['host','path','expiry','isSecure','isHttpOnly','sameSite','originAttributes'];
  if (required.some(c => !columns.has(c))) throw 'format';
  if (columns.has('top_frame_site_key') && !columns.has('has_cross_site_ancestor')) throw 'format';
  const expr = (col, fallback) => columns.has(col) ? col : fallback;
  const fields = chrome
    ? ['host_key AS host','path','expires_utc AS expiry','is_persistent AS persistent','is_secure AS secure','is_httponly AS httpOnly','samesite AS sameSite',expr('top_frame_site_key',"''")+' AS partition',expr('has_cross_site_ancestor','0')+' AS ancestor',"'' AS attributes",expr('source_scheme','0')+' AS sourceScheme',expr('source_port','-1')+' AS sourcePort']
    : ['host','path','expiry','1 AS persistent','isSecure AS secure','isHttpOnly AS httpOnly','sameSite',"'' AS partition",'0 AS ancestor','originAttributes AS attributes','0 AS sourceScheme','-1 AS sourcePort'];
  if (d.values) fields.push('name','value',chrome ? 'encrypted_value AS encrypted' : "X'' AS encrypted");
  // Covering host index scan (metadata only), followed by exact indexed site-host queries.
  // Normal Chromium/Firefox indices cannot seek a domain suffix; never scan value payloads.
  const hosts = d.scope.exact ? [{ host: d.scope.host }, { host: '.'+d.scope.host }] : db.prepare('SELECT DISTINCT '+host+' AS host FROM '+table).iterate();
  const stmt = db.prepare('SELECT '+fields.join(',')+' FROM '+table+' WHERE '+host+' = ?');
  stmt.setReadBigInts(true);
  const rows = [];
  for (const h of hosts) {
    const bare = h.host.replace(/^\./,'').toLowerCase();
    if (bare !== d.scope.host && (d.scope.exact || !bare.endsWith('.'+d.scope.host))) continue;
    for (const row of stmt.iterate(h.host)) {
      const seconds = chrome ? Number(row.expiry / 1000000n - 11644473600n) : Number(row.expiry);
      if (row.persistent && seconds <= d.now) continue;
      if (rows.length >= 5000) throw 'format';
      rows.push(row);
    }
  }
  db.exec('COMMIT'); parentPort.postMessage({ version, rows });
} catch (e) { parentPort.postMessage({ error: e === 'format' || [11, 26].includes(e?.errcode & 0xff) ? 'format' : { errcode: e?.errcode } }); }
finally { db?.close(); }
`
export async function fileFingerprint(source: Source, platform: NodeJS.Platform = process.platform) {
  const hashes: string[] = []
  // SQLite may create an empty WAL on read-only open; zero bytes and absent both mean no WAL
  // content. Hashing its mere creation would reject an unchanged source on every first read.
  for (const file of [source.file, source.file + '-wal']) {
    try { const s = await stat(file, { bigint: true }); hashes.push(file.endsWith('-wal') && s.size === 0n ? 'absent' : [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')) }
    catch (e) { if (file === source.file || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw readFailure(e, platform, source.browser); hashes.push('absent') }
  }
  return createHash('sha256').update(hashes.join('|')).digest('hex')
}
export async function readStore(source: Source, scope: SiteScope, values: boolean, signal: AbortSignal, platform: NodeJS.Platform = process.platform): Promise<StoreRead> {
  // TCC can allow stat yet deny open; probe in the host before SQLite loses the filesystem errno.
  try { const file = await open(source.file, 'r'); await file.close() } catch (error) { throw readFailure(error, platform, source.browser) }
  const fingerprint = await fileFingerprint(source, platform)
  if (signal.aborted) throw new SigninFault('key')
  const result = await new Promise<Omit<StoreRead, 'fingerprint'>>((resolve, reject) => {
    const worker = new Worker(reader, { eval: true, workerData: { file: source.file, family: source.family, scope, values, now: Date.now() / 1000 }, stderr: true })
    // Experimental SQLite warnings/errors never enter browser logs with arbitrary row/path material.
    worker.stderr.resume()
    let finished = false
    const finish = (error?: SigninFault, data?: Omit<StoreRead, 'fingerprint'>) => {
      if (finished) return
      finished = true
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      void worker.terminate().finally(() => { if (error) reject(error); else resolve(data!) })
    }
    const abort = () => finish(new SigninFault('key'))
    const timer = setTimeout(() => finish(new SigninFault('unreadable')), 15000)
    signal.addEventListener('abort', abort, { once: true })
    worker.once('message', data => data.error ? finish(data.error === 'format' ? new SigninFault('format') : readFailure(data.error, platform, source.browser)) : finish(undefined, data))
    worker.once('error', () => finish(new SigninFault('unreadable')))
    worker.once('exit', () => finish(new SigninFault('unreadable')))
  }).catch(error => { throw error instanceof SigninFault ? error : new SigninFault('unreadable') })
  try {
    if (signal.aborted || fingerprint !== await fileFingerprint(source, platform)) throw new SigninFault('changed')
  } catch (error) {
    for (const row of result.rows) { row.encrypted?.fill(0); row.value = undefined }
    throw error
  }
  return { ...result, fingerprint }
}
