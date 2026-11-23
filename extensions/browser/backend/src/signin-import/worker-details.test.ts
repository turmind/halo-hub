import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BrowserContext, Page } from 'playwright'
import { commitCookies } from './import-cookies.js'
import { host } from './fixtures.js'
import { SigninFault, reasons } from './types.js'

for (const count of [1, 7]) test(`active workers list tab IDs and origins only, capped at five (${count} tabs)`, async () => {
  const pages = Array.from({ length: count }, (_, i) => ({ url: () => `https://page${i}.example.com/private/path?secret=hidden`, workers: () => [{}] })) as unknown as Page[]
  const context = { pages: () => pages, serviceWorkers: () => [], route: () => assert.fail('must refuse before writes') } as unknown as BrowserContext
  const withContext = async <T>(work: (context: BrowserContext) => Promise<T>) => work(context)
  const bound = { ...host(), withCommit: async <T>(work: (target: import('../signin-service.js').SigninCommit) => Promise<T>) => work({ tabId: page => `tab-${pages.indexOf(page)}`, withContext, cleanup: withContext, checkpoint: async () => assert.fail('no checkpoint') }) }
  await assert.rejects(commitCookies(bound, [], bound.signal), error => {
    assert.ok(error instanceof SigninFault); assert.equal(error.reason, 'activeWorkers')
    assert.equal(error.message, reasons.activeWorkers + '\n' + pages.slice(0, 5).map((_, i) => `tab-${i} https://page${i}.example.com`).join('\n') + (count > 5 ? '\n…' : ''))
    assert.doesNotMatch(error.message, /private|secret|hidden/); return true
  })
})
test('service workers identify same-origin tabs and origins without an open page', async () => {
  const page = { url: () => 'https://passport.jd.com/login?secret=hidden', workers: () => [] } as unknown as Page
  const context = { pages: () => [page], serviceWorkers: () => [
    { url: () => 'https://passport.jd.com/private/sw.js?key=hidden' },
    { url: () => 'https://background.example.com/private/scope/sw.js?key=hidden' },
  ] } as unknown as BrowserContext
  const withContext = async <T>(work: (context: BrowserContext) => Promise<T>) => work(context)
  const bound = { ...host(), withCommit: async <T>(work: (target: import('../signin-service.js').SigninCommit) => Promise<T>) => work({ tabId: () => 'current-tab-id', withContext, cleanup: withContext, checkpoint: async () => assert.fail('no checkpoint') }) }
  await assert.rejects(commitCookies(bound, [], bound.signal), { reason: 'activeWorkers', message: reasons.activeWorkers + '\ncurrent-tab-id https://passport.jd.com\nservice-worker https://background.example.com' })
})
