import { isIP } from 'node:net'
import { getDomain } from 'tldts'
import { SigninFault } from './types.js'

export interface SiteScope { host: string; exact: boolean }
export function siteScope(input: string): SiteScope {
  try {
    const raw = input.trim()
    if (!raw || /[\\*\s]/.test(raw)) throw new Error()
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host) throw new Error()
    const exact = !!isIP(host) || host === 'localhost'
    if (!exact && (!getDomain(host, { allowPrivateDomains: true }) || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part)))) throw new Error()
    return { host, exact }
  } catch { throw new SigninFault('site') }
}
export function matches(host: string, scope: SiteScope) {
  const bare = host.replace(/^\./, '').toLowerCase()
  return bare === scope.host || !scope.exact && bare.endsWith(`.${scope.host}`)
}
