import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ProfileStore } from '../../backend/src/profile-store.js'
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

for (const stage of ['front', 'visible', 'capture', 'dispose-error', 'dispose-timeout'] as const) test(`screenshot recovery budget isolates late ${stage}`, { timeout: 20000 }, async t => {
  const f = await fixture()
  try {
    const caller = session()
    assert.equal((await http(f.socket, caller, '/command', { id: 'open', op: 'open', args: { url: f.origin } })).body.ok, true)
    const page = f.contexts[0].pages()[0]; const events: string[] = []
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve })
    const pause = async (name: string) => { events.push(name); if (stage === name || stage === 'dispose-timeout' && name === 'dispose') { started(); await gate } }
    t.mock.method(page, 'bringToFront', () => pause('front'))
    const handle = await page.evaluateHandle(() => true)
    t.mock.method(handle, 'dispose', async () => { await pause('dispose'); if (stage === 'dispose-error') throw new Error('manufactured dispose error') })
    t.mock.method(page, 'waitForFunction', async () => { await pause('visible'); return handle })
    let captures = 0
    t.mock.method(page, 'screenshot', async () => {
      if (++captures === 1) throw new Error(emptySurface)
      await pause('capture'); return Buffer.from('manufactured-png')
    })
    // Capture the real deadline callbacks without replacing clearTimeout for already-live backend timers.
    const clock = t.mock.method(performance, 'now', () => 1000)
    const timeout = globalThis.setTimeout; const deadlines: (() => void)[] = []
    const timers = t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay === 10000) deadlines.push(() => callback(...args))
      return timeout(callback, delay, ...args)
    }) as typeof setTimeout)
    const request = { id: 'budget', op: 'screenshot' as const, args: {} }
    const pending = f.backend.command(caller, request)
    let response
    if (stage === 'dispose-error') response = await pending
    else {
      await entered
      let finished = false; void pending.then(() => { finished = true })
      clock.mock.mockImplementation(() => 10999); await Promise.resolve(); assert.equal(finished, false)
      clock.mock.mockImplementation(() => 11000)
      assert.equal(deadlines.length, stage === 'front' ? 2 : stage === 'visible' ? 3 : stage === 'capture' ? 4 : 5)
      deadlines.at(-1)!(); response = await pending
    }
    timers.mock.restore(); clock.mock.restore()
    const disposed = stage.startsWith('dispose')
    assert.equal(response.ok, disposed)
    if (!response.ok) { assert.ok('error' in response); assert.equal(response.error.code, 'operation-failed') }
    assert.equal((await f.backend.command(caller, { id: 'after', op: 'tabs', args: {} })).ok, true) // Serial lock released.
    const before = [...events]; release()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(events, before) // Late completion must not continue to the next recovery step.
    assert.deepEqual(await f.backend.command(caller, request), response)
    const artifacts = join(new ProfileStore(join(f.directory, 'data'), caller.projectId).directory, 'artifacts')
    assert.equal((await readdir(artifacts)).length, disposed ? 1 : 0)
  } finally { t.mock.restoreAll(); await f.close() }
})
