import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, http, session } from './fixtures.js'

const noPassword = (value: unknown, passwords: string[]) => {
  if (typeof value === 'string') for (const password of passwords) assert.ok(!value.includes(password), 'read contained a password value')
  else if (value && typeof value === 'object') for (const child of Object.values(value)) noPassword(child, passwords)
}

test('read redacts collected password values across frames and every output string', async t => {
  const f = await fixture(); t.after(() => f.close())
  const caller = session()
  await http(f.socket, caller, '/command', { id: 'open', op: 'open', args: { url: f.origin } })
  const page = f.contexts[0].pages()[0]
  const read = () => http(f.socket, caller, '/command', { id: crypto.randomUUID(), op: 'read', args: {} })

  await t.test('ordinary and nested iframe passwords are masked and frame identities stripped', async () => {
    await page.setContent('<iframe></iframe>')
    const child = await page.locator('iframe').elementHandle().then(handle => handle!.contentFrame())
    assert.ok(child)
    await child.setContent('<input type="password" value="frame-password"><iframe></iframe>')
    const nested = await child.locator('iframe').elementHandle().then(handle => handle!.contentFrame())
    assert.ok(nested)
    await nested.setContent('<input type="password" value="nested-password">')
    const raw = await page.locator('body').ariaSnapshot({ mode: 'ai' })
    assert.match(raw, /frame-password/); assert.match(raw, /nested-password/); assert.match(raw, /\[ref=f/)
    const response = await read(); assert.equal(response.body.ok, true)
    noPassword(response.body, ['frame-password', 'nested-password'])
    assert.doesNotMatch(response.body.result.ariaSnapshot, /\[ref=[^\]]+\]/)
    assert.equal(await child.locator('input').inputValue(), 'frame-password')
    assert.equal(await nested.locator('input').inputValue(), 'nested-password')
  })

  await t.test('role=link list values, derived names and echoed text/title/url/ref names are masked longest first', async () => {
    const passwords = ['manufactured-pass', 'manufactured-pass-long']
    await page.setContent('<input id="password" type="password" role="link" href="/next" value="manufactured-pass"><input id="derived" type="password" value="manufactured-pass-long"><button aria-labelledby="derived">Derived</button><button aria-label="manufactured-pass-long">manufactured-pass</button><p>manufactured-pass-long</p><input value="ordinary-value"><div id="shadow"></div>')
    await page.locator('#shadow').evaluate(node => { node.attachShadow({ mode: 'open' }).innerHTML = '<input type="password" value="shadow-password">' })
    await page.evaluate(() => { document.title = 'manufactured-pass-long'; history.replaceState(null, '', '#manufactured-pass-long') })
    const raw = await page.locator('body').ariaSnapshot({ mode: 'ai' })
    assert.match(raw, /link[^\n]+:\n/); assert.equal(raw.match(/button "manufactured-pass-long"/g)?.length, 2)
    const response = await read(); assert.equal(response.body.ok, true)
    noPassword(response.body, [...passwords, 'shadow-password'])
    assert.equal(response.body.result.title, '••••'); assert.ok(response.body.result.url.endsWith('#••••'))
    assert.match(response.body.result.ariaSnapshot, /ordinary-value/)
    assert.ok(response.body.result.refs.some((ref: { name: string }) => ref.name === '••••'))
    assert.equal(await page.locator('#password').inputValue(), passwords[0])
    assert.equal(await page.locator('#shadow input').inputValue(), 'shadow-password')
  })

  for (const change of ['type', 'value'] as const) await t.test(`${change} changes between samples fail closed without closing the browser`, async t => {
    await page.setContent('<input type="password" value="before-password">')
    const body = page.locator('body'); const snapshot = body.ariaSnapshot.bind(body); const locator = page.locator.bind(page)
    t.mock.method(body, 'ariaSnapshot', async (...args: Parameters<typeof snapshot>) => {
      const raw = await snapshot(...args)
      await page.locator('input').evaluate((node, change) => { const input = node as HTMLInputElement; if (change === 'type') input.type = 'text'; else input.value = 'after-password' }, change)
      return raw
    })
    t.mock.method(page, 'locator', ((selector: string, options: Parameters<typeof locator>[1]) => selector === 'body' ? body : locator(selector, options)) as typeof locator)
    const response = await read()
    assert.equal(response.body.ok, false); assert.equal(response.body.error.code, 'operation-failed')
    noPassword(response.body, ['before-password', 'after-password'])
    assert.equal((await http(f.socket, caller, '/status')).body.status, 'ready'); assert.equal(page.isClosed(), false)
  })

  await t.test('mounted frame collection errors fail closed; detached frames are skipped', async t => {
    await page.setContent('<iframe></iframe>')
    const frame = await page.locator('iframe').elementHandle().then(handle => handle!.contentFrame()); assert.ok(frame)
    const passwords = frame.locator('input[type=password]'); const locator = frame.locator.bind(frame)
    t.mock.method(frame, 'locator', ((selector: string, options: Parameters<typeof locator>[1]) => selector === 'input[type=password]' ? passwords : locator(selector, options)) as typeof locator)
    const failed = t.mock.method(passwords, 'evaluateAll', async () => { throw new Error('manufactured collection failure') })
    const response = await read()
    assert.equal(response.body.ok, false); assert.equal(response.body.error.code, 'operation-failed')
    failed.mock.mockImplementation(async () => { await page.locator('iframe').evaluate(node => node.remove()); throw new Error('detached') })
    assert.equal((await read()).body.ok, true)
    assert.equal(frame.isDetached(), true)
  })

  await t.test('closed shadow roots are traversed by neither password collection nor ARIA snapshots', async () => {
    await page.setContent('<p>Visible</p><div id="closed"></div>')
    await page.locator('#closed').evaluate(node => { node.attachShadow({ mode: 'closed' }).innerHTML = '<input type="password" aria-label="Closed password" value="closed-password"><p>closed-only-text</p>' })
    assert.deepEqual(await page.locator('input[type=password]').evaluateAll(els => els.map(el => (el as HTMLInputElement).value)), [])
    const raw = await page.locator('body').ariaSnapshot({ mode: 'ai' })
    assert.doesNotMatch(raw, /closed-password|Closed password|closed-only-text/)
    const response = await read(); assert.equal(response.body.ok, true)
    noPassword(response.body, ['closed-password']); assert.match(response.body.result.text, /Visible/)
  })
})

test('10k-item read uses two batch password collections and completes within three seconds', async t => {
  const f = await fixture(); t.after(() => f.close())
  const caller = session()
  await http(f.socket, caller, '/command', { id: 'open', op: 'open', args: { url: f.origin } })
  const page = f.contexts[0].pages()[0]
  await page.setContent('<input type="password" value="large-page-password"><ul>' + Array.from({ length: 10000 }, (_, i) => `<li>Item ${i}</li>`).join('') + '</ul>')
  const frame = page.mainFrame(); const passwords = frame.locator('input[type=password]'); const locator = frame.locator.bind(frame)
  const collect = t.mock.method(passwords, 'evaluateAll')
  t.mock.method(frame, 'locator', ((selector: string, options: Parameters<typeof locator>[1]) => selector === 'input[type=password]' ? passwords : locator(selector, options)) as typeof locator)
  const started = performance.now()
  const response = await http(f.socket, caller, '/command', { id: 'large-read', op: 'read', args: {} })
  const elapsed = performance.now() - started
  t.diagnostic(`10k read: ${elapsed.toFixed(1)} ms`)
  assert.equal(response.body.ok, true); assert.ok(elapsed < 3000, `read took ${elapsed.toFixed(1)} ms`)
  assert.equal(collect.mock.callCount(), 2); noPassword(response.body, ['large-page-password'])
  assert.equal((await http(f.socket, caller, '/status')).body.status, 'ready'); assert.equal(page.isClosed(), false)
})
