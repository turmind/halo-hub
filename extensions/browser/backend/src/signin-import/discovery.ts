import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { label, readFailure, type Machine, type Source } from './types.js'

export const currentMachine = (): Machine => ({ platform: process.platform, home: homedir(), env: process.env })
type ReadError = (error: unknown) => void
export async function jsonFile(file: string, onError?: ReadError): Promise<Record<string, any>> {
  try { const value: unknown = JSON.parse(await readFile(file, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch (error) { onError?.(error); return {} }
}
export function appBound(state: Record<string, any>) { return !!state.os_crypt && Object.hasOwn(state.os_crypt, 'app_bound_encrypted_key') }
async function exists(file: string, onError?: ReadError) { try { return (await stat(file)).isFile() } catch (error) { onError?.(error); return undefined } }
async function directories(root: string, onError?: ReadError) { try { return (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name) } catch (error) { onError?.(error); return [] } }
async function inside(root: string, file: string, onError?: ReadError) {
  try { const part = relative(await realpath(root), await realpath(file)); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) } catch (error) { onError?.(error); return undefined }
}
interface Root { browser: string; root: string; family: Source['family']; service?: string; account?: string; application?: string }
export async function browserRoots(machine: Machine): Promise<Root[]> {
  const { home, env, platform } = machine
  const mac = join(home, 'Library', 'Application Support')
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  const roaming = env.APPDATA || join(home, 'AppData', 'Roaming')
  const linux = env.XDG_CONFIG_HOME || join(home, '.config')
  const roots: Root[] = []
  const chromium = (browser: string, macPath: string, winPath: string, linuxPath: string, account: string, application: string, winRoaming = false) => {
    const location = platform === 'darwin' ? macPath && join(mac, macPath) : platform === 'win32' ? winPath && join(winRoaming ? roaming : local, winPath) : platform === 'linux' ? linuxPath && join(linux, linuxPath) : ''
    if (location) roots.push({ browser, root: location, family: 'chromium', account, service: account + ' Safe Storage', application })
  }
  for (const [suffix, macSuffix, winSuffix, linuxSuffix] of [['', '', '', ''], [' Beta', ' Beta', ' Beta', '-beta'], [' Dev', ' Dev', ' Dev', '-unstable'], [' Canary', ' Canary', ' SxS', '']] as const) {
    chromium('Chrome' + suffix, 'Google/Chrome' + macSuffix, 'Google/Chrome' + winSuffix + '/User Data', suffix === ' Canary' ? '' : 'google-chrome' + linuxSuffix, 'Chrome', 'chrome')
    chromium('Edge' + suffix, 'Microsoft Edge' + macSuffix, 'Microsoft/Edge' + winSuffix + '/User Data', suffix === ' Canary' ? '' : 'microsoft-edge' + (suffix === ' Dev' ? '-dev' : linuxSuffix), 'Microsoft Edge', 'microsoft-edge')
  }
  for (const suffix of ['', '-Beta', '-Nightly']) chromium('Brave' + suffix, 'BraveSoftware/Brave-Browser' + suffix, 'BraveSoftware/Brave-Browser' + suffix + '/User Data', 'BraveSoftware/Brave-Browser' + suffix, 'Brave', 'brave')
  chromium('Chromium', 'Chromium', 'Chromium/User Data', 'chromium', 'Chromium', 'chromium')
  chromium('Vivaldi', 'Vivaldi', 'Vivaldi/User Data', 'vivaldi', 'Vivaldi', 'vivaldi')
  chromium('Vivaldi Snapshot', 'Vivaldi Snapshot', 'Vivaldi Snapshot/User Data', 'vivaldi-snapshot', 'Vivaldi', 'vivaldi')
  chromium('Arc', 'Arc/User Data', '', '', 'Arc', 'arc')
  for (const [title, folder, linuxFolder] of [['Opera', 'Opera Stable', 'opera'], ['Opera Beta', 'Opera Next', 'opera-beta'], ['Opera Developer', 'Opera Developer', 'opera-developer'], ['Opera GX', 'Opera GX Stable', '']] as const) chromium(title, 'com.operasoftware.' + (title === 'Opera GX' ? 'OperaGX' : title === 'Opera Beta' ? 'OperaNext' : title === 'Opera Developer' ? 'OperaDeveloper' : 'Opera'), 'Opera Software/' + folder, linuxFolder, 'Opera', 'opera', true)
  const firefox = (browser: string, root: string) => roots.push({ browser, root, family: 'firefox' })
  if (platform === 'darwin') {
    for (const name of ['Firefox', 'Firefox Developer Edition', 'Firefox Nightly', 'LibreWolf', 'Waterfox', 'Floorp', 'Zen']) firefox(name, join(mac, name))
  } else if (platform === 'win32') {
    for (const name of ['Mozilla/Firefox', 'Mozilla/Firefox Developer Edition', 'LibreWolf', 'Waterfox', 'Floorp', 'Zen']) firefox(name, join(roaming, name))
    for (const pkg of await directories(join(local, 'Packages'))) {
      if (pkg.startsWith('TheBrowserCompany.Arc_')) roots.push({ browser: 'Arc', family: 'chromium', root: join(local, 'Packages', pkg, 'LocalCache/Local/Arc/User Data'), service: 'Arc Safe Storage', account: 'Arc', application: 'arc' })
      if (pkg.startsWith('Mozilla.Firefox_')) firefox('Firefox MSIX', join(local, 'Packages', pkg, 'LocalCache/Roaming/Mozilla/Firefox'))
    }
  } else if (platform === 'linux') {
    for (const [name, dir] of [['Firefox', '.mozilla/firefox'], ['Firefox Developer', '.mozilla/firefox-dev'], ['Firefox Nightly', '.mozilla/firefox-nightly'], ['LibreWolf', '.librewolf'], ['Waterfox', '.waterfox'], ['Floorp', '.floorp'], ['Zen', '.zen']]) firefox(name, join(home, dir))
    firefox('Firefox Snap', join(home, 'snap/firefox/common/.mozilla/firefox'))
    roots.push({ browser: 'Chromium Snap', family: 'chromium', root: join(home, 'snap/chromium/common/chromium'), service: 'Chromium Safe Storage', account: 'Chromium', application: 'chromium' })
    for (const [app, browser, dir, account, application] of [['org.chromium.Chromium', 'Chromium', 'chromium', 'Chromium', 'chromium'], ['com.google.Chrome', 'Chrome', 'google-chrome', 'Chrome', 'chrome'], ['com.microsoft.Edge', 'Edge', 'microsoft-edge', 'Microsoft Edge', 'microsoft-edge'], ['com.brave.Browser', 'Brave', 'BraveSoftware/Brave-Browser', 'Brave', 'brave'], ['com.vivaldi.Vivaldi', 'Vivaldi', 'vivaldi', 'Vivaldi', 'vivaldi'], ['com.opera.Opera', 'Opera', 'opera', 'Opera', 'opera']]) roots.push({ browser: browser + ' Flatpak', family: 'chromium', root: join(home, '.var/app', app, 'config', dir), service: account + ' Safe Storage', account, application })
    for (const [app, browser, dir] of [['org.mozilla.firefox', 'Firefox', '.mozilla/firefox'], ['io.gitlab.librewolf-community', 'LibreWolf', '.librewolf'], ['net.waterfox.waterfox', 'Waterfox', '.waterfox'], ['one.ablaze.floorp', 'Floorp', '.floorp'], ['app.zen_browser.zen', 'Zen', '.zen']]) firefox(browser + ' Flatpak', join(home, '.var/app', app, dir))
  }
  return roots
}

export async function discover(machine: Machine): Promise<Source[]> {
  const sources: Source[] = []; const seen = new Set<string>()
  const blocked = new Map<string, Source>()
  const failure = (root: Root, metadata = false) => {
    let reason: Source['unavailable']
    return { get reason() { return reason }, onError: (error: unknown) => {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT' && (metadata || code !== 'ENOTDIR')) reason ??= readFailure(error, machine.platform, root.browser).reason
    } }
  }
  const report = (root: Root): ReadError => error => {
    const denied = failure(root); denied.onError(error)
    if (denied.reason) blocked.set(root.root, { ...root, file: root.root, profile: 'Unavailable profiles', id: createHash('sha256').update(root.root).digest('hex').slice(0, 32), unavailable: denied.reason })
  }
  const add = async (root: Root, file: string, profile: string, unavailable?: Source['unavailable']) => {
    const denied = failure(root)
    const present = await exists(file, denied.onError)
    if (!present && !denied.reason) return false
    let canonical = file
    try { canonical = await realpath(file) } catch (error) { denied.onError(error) }
    const contained = await inside(root.root, file, denied.onError)
    if (contained === undefined && !denied.reason) return false
    if (seen.has(canonical)) return true
    seen.add(canonical)
    unavailable = denied.reason ?? (contained === false ? 'scope' : unavailable)
    sources.push({ ...root, file: canonical, profile: label(profile, 'Profile'), id: createHash('sha256').update(canonical).digest('hex').slice(0, 32), ...(unavailable ? { unavailable } : {}) })
    return true
  }
  for (const root of await browserRoots(machine)) {
    const onError = report(root)
    if (root.family === 'chromium') {
      const rootFailure = failure(root, true)
      const state = await jsonFile(join(root.root, 'Local State'), error => { rootFailure.onError(error); onError(error) })
      const profiles = new Set(['Default', ...Object.keys(state.profile?.info_cache ?? {}), ...await directories(root.root, onError)])
      for (const profile of profiles) {
        if (profile.includes('/') || profile.includes('\\') || profile === '..' || /^(Guest Profile|System Profile)$/.test(profile)) continue
        const denied = failure(root)
        const contained = await inside(root.root, join(root.root, profile), denied.onError)
        if (contained === false || contained === undefined && !denied.reason) continue
        const pref = contained === true ? await jsonFile(join(root.root, profile, 'Preferences'), denied.onError) : {}
        const name = denied.reason ? 'Unavailable profile' : label(pref.profile?.name, profile)
        for (const file of ['Network/Cookies', 'Cookies']) {
          if (await add(root, join(root.root, profile, file), name, denied.reason ?? (machine.platform === 'win32' && appBound(state) ? 'appBound' : undefined))) break
        }
      }
      // Opera stores Cookies directly in its standard root on some platforms.
      for (const file of ['Network/Cookies', 'Cookies']) if (await add(root, join(root.root, file), 'Default', machine.platform === 'win32' && appBound(state) ? 'appBound' : undefined)) break
      // Local State supplies names, key metadata and app-bound protection for every profile in this root.
      if (rootFailure.reason) for (const source of sources) if (source.root === root.root) source.unavailable = rootFailure.reason
    } else {
      const candidates = new Map<string, string>()
      for (const file of ['profiles.ini', 'installs.ini']) {
        let ini = ''; try { ini = await readFile(join(root.root, file), 'utf8') } catch (error) { onError(error) }
        for (const section of ini.split(/^\[/m)) {
          const fields = Object.fromEntries([...section.matchAll(/^([^=\r\n]+)=(.*)$/gm)].map(m => [m[1].trim(), m[2].trim()]))
          const p = fields.Path || fields.Default
          if (p) candidates.set(isAbsolute(p) ? p : join(root.root, p), label(fields.Name, p.split(/[\\/]/).pop() || 'Profile'))
        }
      }
      for (const base of [root.root, join(root.root, 'Profiles')]) for (const dir of await directories(base, onError)) if (!candidates.has(join(base, dir))) candidates.set(join(base, dir), dir)
      for (const [dir, name] of candidates) {
        // Do not open a redirected custom profile, even to obtain its metadata.
        const denied = failure(root)
        const contained = await inside(root.root, dir, denied.onError)
        if (contained === false || contained === undefined && !denied.reason) continue
        await add(root, join(dir, 'cookies.sqlite'), name, denied.reason)
      }
    }
  }
  if (machine.platform === 'darwin') {
    for (const app of ['com.apple.Safari', 'com.apple.SafariTechnologyPreview']) {
      const root: Root = { browser: app.endsWith('TechnologyPreview') ? 'Safari Technology Preview' : 'Safari', family: 'safari', root: join(machine.home, 'Library/Containers', app, 'Data/Library') }
      await add(root, join(root.root, 'Cookies/Cookies.binarycookies'), 'Default')
      for (const base of [join(root.root, 'WebKit/WebsiteDataStore'), join(machine.home, 'Library/WebKit', app, 'WebsiteDataStore')]) for (const id of await directories(base, report({ ...root, root: base }))) for (const file of ['Cookies.binarycookies', 'Cookies/Cookies.binarycookies', 'Cookies/Cookies.sqlite']) await add({ ...root, root: base }, join(base, id, file), id, 'format')
    }
    await add({ browser: 'Safari', family: 'safari', root: join(machine.home, 'Library/Cookies') }, join(machine.home, 'Library/Cookies/Cookies.binarycookies'), 'Legacy')
  }
  const populated = new Set(sources.map(source => source.root))
  return [...sources, ...[...blocked.values()].filter(source => !populated.has(source.root))]
}
