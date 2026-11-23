import { spawn } from 'node:child_process'
import { pbkdf2Sync } from 'node:crypto'
import { join } from 'node:path'
import { appBound, jsonFile } from './discovery.js'
import { check, SigninFault, type Machine, type Source } from './types.js'
import { secretService } from './secret-service.js'

export type ToolRunner = (file: string, args: string[], input: Buffer | undefined, signal: AbortSignal) => Promise<Buffer>
/** Secret input/output uses pipes only; OS exceptions/stderr are intentionally discarded. */
export const runTool: ToolRunner = (file, args, input, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new SigninFault('key')); return }
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const chunks: Buffer[] = []; let size = 0; let failed = false
  const abort = () => { if (killTimer) return; failed = true; child.kill(); killTimer = setTimeout(() => child.kill('SIGKILL'), 500) }
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(abort, 120000)
  signal.addEventListener('abort', abort, { once: true })
  child.stdout.on('data', (data: Buffer) => { size += data.length; if (size > 1024 * 1024) { data.fill(0); abort() } else chunks.push(data) })
  child.stderr.on('data', (data: Buffer) => data.fill(0))
  child.stdin.on('error', () => { failed = true })
  child.once('error', () => { failed = true })
  child.once('close', code => {
    clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', abort)
    const result = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0)
    if (code || failed || signal.aborted) {
      result.fill(0)
      // security exits with the low byte of OSStatus: errSecAuthFailed (-25293) / errSecUserCanceled (-128).
      const denied = file === '/usr/bin/security' && !failed && !signal.aborted && (code === 51 || code === 128)
      reject(new SigninFault(denied ? 'keychain' : 'key', { service: args[args.indexOf('-s') + 1] }))
    } else resolve(result)
  })
  child.stdin.end(input)
})
const dpapiScript = "Add-Type -AssemblyName System.Security; try { $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r)); [Array]::Clear($b,0,$b.Length); [Array]::Clear($r,0,$r.Length) } catch { exit 1 }"
export async function unprotect(value: Buffer, machine: Machine, signal: AbortSignal, run: ToolRunner = runTool) {
  const file = join(machine.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const input = Buffer.from(value.toString('base64'))
  let output: Buffer | undefined
  try {
    output = await run(file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', dpapiScript], input, signal)
    const text = output.toString().trim()
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new SigninFault('key')
    return Buffer.from(text, 'base64')
  } finally { input.fill(0); output?.fill(0) }
}
export class OsSecrets {
  private keys = new Map<string, Buffer>()
  private macFailures = new Map<string, SigninFault>()
  constructor(private machine: Machine, private signal: AbortSignal, private run: ToolRunner = runTool, private wallet = secretService) {}
  async macBatch(sources: Source[]) {
    const items = new Map(sources.filter(s => s.family === 'chromium' && !s.unavailable && s.service && s.account).map(s => [s.service + '\0' + s.account, s]))
    // Launch every independent security process before awaiting any result; OS controls dialog stacking.
    await Promise.allSettled([...items].map(async ([id, source]) => {
      if (this.keys.has(id) || this.macFailures.has(id)) return
      let password: Buffer | undefined
      try {
        password = await this.run('/usr/bin/security', ['find-generic-password', '-w', '-s', source.service!, '-a', source.account!], undefined, this.signal)
        // security appends one newline, not arbitrary whitespace trimming from the password.
        const end = password.length && password[password.length - 1] === 10 ? password.length - 1 : password.length
        check(this.signal)
        this.keys.set(id, pbkdf2Sync(password.subarray(0, end), 'saltysalt', 1003, 16, 'sha1'))
      } catch (error) { this.macFailures.set(id, error instanceof SigninFault ? error : new SigninFault('key')) } finally { password?.fill(0) }
    }))
  }
  async chromiumKey(source: Source, envelope: 'v10' | 'v11') {
    check(this.signal)
    if (this.machine.platform === 'darwin') {
      if (envelope !== 'v10') throw new SigninFault('format')
      const key = this.keys.get(source.service + '\0' + source.account)
      if (!key) throw this.macFailures.get(source.service + '\0' + source.account) ?? new SigninFault('key')
      return key
    }
    if (this.machine.platform === 'win32') {
      const state = await jsonFile(join(source.root, 'Local State'))
      if (appBound(state)) throw new SigninFault('appBound')
      if (envelope !== 'v10') throw new SigninFault('format')
      if (!this.keys.has(source.root)) {
        const encoded = state.os_crypt?.encrypted_key
        if (typeof encoded !== 'string') throw new SigninFault('key')
        const blob = Buffer.from(encoded, 'base64')
        try {
          if (blob.subarray(0, 5).toString() !== 'DPAPI') throw new SigninFault('format')
          const key = await unprotect(blob.subarray(5), this.machine, this.signal, this.run)
          if (key.length !== 32) { key.fill(0); throw new SigninFault('key') }
          this.keys.set(source.root, key)
        } finally { blob.fill(0) }
      }
      return this.keys.get(source.root)!
    }
    if (this.machine.platform !== 'linux') throw new SigninFault('key')
    const id = envelope === 'v10' ? 'linux-basic' : source.application!
    if (!this.keys.has(id)) {
      const password = envelope === 'v10' ? Buffer.from('peanuts') : await this.wallet(source.application!, this.machine, this.signal)
      try { this.keys.set(id, pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1')) } finally { password.fill(0) }
    }
    return this.keys.get(id)!
  }
  dpapi(value: Buffer) { return unprotect(value, this.machine, this.signal, this.run) }
  dispose() { for (const key of this.keys.values()) key.fill(0); this.keys.clear() }
}
