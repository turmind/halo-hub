import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import type { Source, Machine, SigninHost } from './types.js'

export const canary = 'manufactured-cookie-value-never-output'
export async function home(platform: NodeJS.Platform = 'linux') {
  const dir = await mkdtemp(join(tmpdir(), 'halo-signin-fixture-'))
  const machine: Machine = { platform, home: dir, env: { LOCALAPPDATA: join(dir, 'AppData/Local'), APPDATA: join(dir, 'AppData/Roaming'), XDG_CONFIG_HOME: join(dir, '.config'), SystemRoot: join(dir, 'Windows') } }
  return { dir, machine, close: () => rm(dir, { recursive: true, force: true }) }
}
export function cbc(host: string, value: string, version = 24, password = 'peanuts', iterations = 1, tag = 'v10') {
  const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1'), Buffer.alloc(16, 32))
  const plain = Buffer.concat([...(version >= 24 ? [createHash('sha256').update(host).digest()] : []), Buffer.from(value)])
  return Buffer.concat([Buffer.from(tag), cipher.update(plain), cipher.final()])
}
export async function chromiumStore(root: string, profile = 'Default', options: { metadataOnly?: boolean; version?: number; host?: string; encrypted?: Buffer; persistent?: boolean; partition?: string; ancestor?: number } = {}) {
  const file = join(root, profile, 'Network/Cookies'); await mkdir(dirname(file), { recursive: true })
  await writeFile(join(root, profile, 'Preferences'), JSON.stringify({ profile: { name: profile } }))
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('version','${options.version ?? 24}'); CREATE TABLE cookies(host_key TEXT,path TEXT,expires_utc INTEGER,is_persistent INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,top_frame_site_key TEXT,has_cross_site_ancestor INTEGER,source_scheme INTEGER,source_port INTEGER${options.metadataOnly ? '' : ',name TEXT,value TEXT,encrypted_value BLOB'}); CREATE INDEX cookie_host ON cookies(host_key);`)
  const host = options.host ?? 'example.com'
  const fields: (string | number | bigint | Buffer)[] = [host, '/', options.persistent === false ? 0n : BigInt(Math.floor(Date.now() / 1000) + 86400 + 11644473600) * 1000000n, options.persistent === false ? 0 : 1, 1, 1, 1, options.partition ?? '', options.ancestor ?? 0, 2, 443]
  if (!options.metadataOnly) fields.push('fixture', '', options.encrypted ?? cbc(host, canary, options.version))
  db.prepare(`INSERT INTO cookies VALUES(${fields.map(() => '?').join(',')})`).run(...fields); db.close()
  const source: Source = { id: profile, browser: 'Chromium', profile, root, file, family: 'chromium', account: 'Chromium', service: 'Chromium Safe Storage', application: 'chromium' }
  return source
}
export function host(confirm: SigninHost['confirm'] = async () => 'cancel'): SigninHost {
  return { caller: { kind: 'session', bindingId: 'fixture', projectId: '/manufactured', sessionId: 'one', rootSessionId: 'one', agentId: 'fixture', userTurnId: 'turn1' }, signal: new AbortController().signal, confirm, withCommit: async () => { throw new Error('fixture has no browser') } }
}
