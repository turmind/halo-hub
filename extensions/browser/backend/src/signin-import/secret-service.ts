import dbus from '@homebridge/dbus-native'
import { SigninFault, type Machine } from './types.js'

interface Bus {
  invoke(message: Record<string, unknown>, callback: (error: unknown, ...values: any[]) => void): void
  connection: { stream: { destroy(): void }; on(event: string, callback: () => void): void }
}
/** Only the unlocked Secret Service item for this browser; no wallet enumeration or basic-key fallback. */
export async function secretService(application: string, machine: Machine, signal: AbortSignal, connect = (address: string) => (dbus as unknown as { sessionBus(options: { busAddress: string }): Bus }).sessionBus({ busAddress: address })): Promise<Buffer> {
  const address = machine.env.DBUS_SESSION_BUS_ADDRESS
  // dbus-native's abstract socket transport requires an optional native addon. Do not load it,
  // execute unixexec addresses or use TCP for secrets; desktop unix:path is the supported transport.
  if (!address || !/^unix:path=[^;,]+(?:,guid=[a-f0-9]+)?$/.test(address) || signal.aborted) throw new SigninFault('wallet')
  let bus: Bus
  try { bus = connect(address) } catch { throw new SigninFault('wallet') }
  let failed = false
  const pending = new Set<() => void>()
  const stop = () => { failed = true; for (const fail of pending) fail(); bus.connection.stream.destroy() }
  bus.connection.on('error', stop)
  bus.connection.on('end', stop)
  signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, 10000)
  const call = (path: string, iface: string, member: string, signature = '', body: unknown[] = []) => new Promise<any>((resolve, reject) => {
    if (failed || signal.aborted) { reject(new SigninFault('wallet')); return }
    const fail = () => reject(new SigninFault('wallet')); pending.add(fail)
    bus.invoke({ destination: 'org.freedesktop.secrets', path, interface: iface, member, signature, body }, (error, ...result) => { pending.delete(fail); if (error) fail(); else resolve(result) })
  })
  const service = '/org/freedesktop/secrets'
  let session: string | undefined
  try {
    const found = await call(service, 'org.freedesktop.Secret.Service', 'SearchItems', 'a{ss}', [[['application', application]]])
    const unlocked = found[0] as string[]; const locked = found[1] as string[]
    if (!Array.isArray(unlocked) || unlocked.length !== 1 || locked.length) throw new SigninFault('wallet')
    const opened = await call(service, 'org.freedesktop.Secret.Service', 'OpenSession', 'sv', ['plain', ['s', '']])
    session = opened[1]
    if (typeof session !== 'string') throw new SigninFault('wallet')
    const secret = await call(unlocked[0], 'org.freedesktop.Secret.Item', 'GetSecret', 'o', [session])
    // Raw invoke returns one callback argument per D-Bus output, here a single struct.
    const value = secret[0]?.[2]
    if (!Buffer.isBuffer(value) && !Array.isArray(value)) throw new SigninFault('wallet')
    const password = Buffer.from(value)
    value.fill(0)
    return password
  } catch { throw new SigninFault('wallet') }
  finally {
    if (session && !failed) await call(session, 'org.freedesktop.Secret.Session', 'Close').catch(() => {})
    clearTimeout(timer); signal.removeEventListener('abort', stop); stop()
  }
}
