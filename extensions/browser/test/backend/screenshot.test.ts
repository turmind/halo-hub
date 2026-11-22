import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, http, session } from './fixtures.js'

const emptySurface = 'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot'
for (const mode of ['recover', 'repeat', 'unrelated', 'not-visible'] as const) test(`screenshot empty-surface recovery: ${mode}`, async t => {
  const f = await fixture()
  try {
    const caller = session()
    const opened = await http(f.socket, caller, '/command', { id: 'open', op: 'open', args: { url: f.origin } })
    assert.equal(opened.body.ok, true)
    const page = f.contexts[0].pages()[0]
    const capture = page.screenshot.bind(page); const front = page.bringToFront.bind(page); const visible = page.waitForFunction.bind(page)
    const events: string[] = []; const budgets: number[] = []
    t.mock.method(page, 'bringToFront', async () => { events.push('front'); await front() })
    t.mock.method(page, 'waitForFunction', async (...args: Parameters<typeof visible>) => {
      events.push('visible')
      if (mode === 'not-visible') throw new Error('manufactured visible-paint timeout')
      return visible(...args)
    })
    t.mock.method(page, 'screenshot', async (options: Parameters<typeof capture>[0]) => {
      events.push('screenshot'); budgets.push(options!.timeout!)
      if (budgets.length === 1 || mode === 'repeat') throw new Error(mode === 'unrelated' ? 'page.screenshot: manufactured unrelated error' : emptySurface + '\nCall log:\n  - manufactured capture')
      assert.equal(await page.evaluate(() => document.visibilityState), 'visible')
      return capture(options)
    })
    const shot = await http(f.socket, caller, '/command', { id: 'shot', op: 'screenshot', args: {} })
    if (mode === 'recover') {
      assert.ok(shot.body.ok && shot.body.result?.artifactId, `screenshot HTTP ${shot.status}: ${shot.body.error?.code ?? 'missing-result'}`)
      assert.equal((await http(f.socket, caller, '/artifacts/' + shot.body.result.artifactId)).status, 200)
    } else { assert.equal(shot.body.ok, false); assert.equal(shot.body.error.code, 'operation-failed') }
    assert.deepEqual(events, mode === 'unrelated' ? ['screenshot'] : mode === 'not-visible' ? ['screenshot', 'front', 'visible'] : ['screenshot', 'front', 'visible', 'screenshot'])
    assert.ok(budgets[0] <= 10000)
    if (budgets.length === 2) assert.ok(budgets[1] < budgets[0])
    assert.ok(!JSON.stringify(shot.body).includes('manufactured'))
  } finally { await f.close() }
})
