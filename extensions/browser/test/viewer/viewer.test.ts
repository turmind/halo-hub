import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chromium, type Frame, type Page } from 'playwright'
import { viewerFixture, root } from './fixture.js'

async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)) }
  assert.fail('condition did not settle')
}
async function frame(page: Page) {
  await page.locator('iframe').waitFor()
  const result = await page.locator('iframe').elementHandle().then(handle => handle!.contentFrame())
  assert.ok(result); return result
}
async function mode(frame: Frame, text: string) { await until(async () => (await frame.locator('#mode').innerText()).includes(text)) }

test('Canvas viewer against real backend: DPI, inputs, ownership, resume and lifecycle', { timeout: 90000 }, async t => {
  execFileSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'pipe' })
  const f = await viewerFixture()
  t.after(() => f.close())
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1000, height: 850 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const opened = await f.command('open', { url: f.origin + '/target' })
  assert.equal(opened.body.ok, true)
  await page.goto(f.origin + '/host')
  const view = await frame(page)
  await mode(view, '2 fps')
  await until(async () => view.locator('#empty').isHidden())
  assert.ok(f.contexts.length >= 2)

  await t.test('frames are decoded, letterboxed and themed at DPR 2', async () => {
    const geometry = await view.locator('#screen').evaluate(canvas => {
      const c = canvas as HTMLCanvasElement; const box = c.getBoundingClientRect()
      return { width: c.width, height: c.height, cssWidth: box.width, cssHeight: box.height, dpr: devicePixelRatio,
        pixel: Array.from(c.getContext('2d')!.getImageData(40, 40, 1, 1).data), background: getComputedStyle(document.body).backgroundColor }
    })
    assert.equal(geometry.dpr, 2); assert.equal(geometry.width, 1280); assert.equal(geometry.height, 800)
    assert.ok(Math.abs(geometry.cssWidth / geometry.cssHeight - 1.6) < 0.001)
    assert.ok(Math.abs(geometry.pixel[0] - 40) < 4); assert.ok(Math.abs(geometry.pixel[1] - 80) < 4)
    assert.equal(geometry.background, 'rgb(21, 32, 48)')
    assert.equal(await view.locator('header').evaluate(node => getComputedStyle(node).backgroundColor), geometry.background)
    assert.ok(f.contexts.every(c => c.projectId === f.init.context.projectId && c.sessionId === 'one'))
  })

  await t.test('compact toolbar, hidden single tab, info popover and passive watch', async () => {
    assert.equal(await view.locator('header').evaluate(node => node.getBoundingClientRect().height), 32)
    assert.equal(await view.locator('#tabs').isHidden(), true)
    assert.equal(await view.locator('#takeover, #chat, #guidance, footer').count(), 0)
    await view.locator('#info').click(); assert.equal(await view.locator('#limits').isVisible(), true)
    await view.locator('#info').click(); assert.equal(await view.locator('#limits').isHidden(), true)
    await view.locator('#info').click(); await view.locator('#address').click()
    assert.equal(await view.locator('#limits').isHidden(), true)
    const before = f.frames.length
    await view.locator('#screen').hover(); await page.mouse.wheel(0, 100)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(f.frames.slice(before).some((frame: any) => frame.type === 'takeover' || frame.type === 'input'), false)
  })
  // Use the backend page only as an assertion oracle, never to send the inputs under test.
  const remote = f.browserContexts[0].pages().find(p => p.url().endsWith('/target'))!
  const clickRemote = async (x: number, y: number) => {
    const box = await view.locator('#screen').boundingBox(); assert.ok(box)
    await page.mouse.click(box.x + x * box.width / 1280, box.y + y * box.height / 800)
  }
  await t.test('pointer, keyboard, IME, paste, wheel, captured drag and blur reach page', async () => {
    const start = f.frames.length
    await clickRemote(180, 110)
    await until(async () => (await remote.locator('button').innerText()) === 'Clicked')
    await mode(view, '10 fps')
    const sent = f.frames.slice(start).filter((frame: any) => frame.type !== 'frame-ack') as any[]
    assert.equal(sent[0].type, 'takeover'); assert.equal(sent[1].type, 'input'); assert.equal(sent[1].event.event, 'down')
    await clickRemote(180, 200)
    await page.keyboard.type('Hello')
    await page.keyboard.press('ArrowLeft')
    await view.locator('#input').evaluate(node => {
      const input = node as HTMLTextAreaElement
      input.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      input.dispatchEvent(new CompositionEvent('compositionend', { data: '中文' }))
      input.value = '中文'; input.dispatchEvent(new InputEvent('input', { data: '中文', inputType: 'insertFromComposition' }))
      const data = new DataTransfer(); data.setData('text/plain', ' pasted')
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data }))
    })
    await until(async () => (await remote.getByRole('textbox', { name: 'Message' }).inputValue()) === 'Hell中文 pastedo')
    await page.keyboard.press('Enter')
    const box = await view.locator('#screen').boundingBox(); assert.ok(box)
    await page.mouse.dblclick(box.x + 120 * box.width / 1280, box.y + 200 * box.height / 800)
    await until(async () => remote.getByRole('textbox', { name: 'Message' }).evaluate(node => {
      const input = node as HTMLInputElement; return input.selectionEnd! > input.selectionStart!
    }))
    await view.locator('#input').evaluate(node => {
      const data = new DataTransfer(); data.setData('text/plain', 'x'.repeat(4097))
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data }))
    })
    assert.match(await view.locator('#error').innerText(), /4,096/)
    assert.equal(await remote.getByRole('textbox', { name: 'Message' }).inputValue(), 'Hell中文 pastedo')
    await page.mouse.move(box.x + 140 * box.width / 1280, box.y + 320 * box.height / 800)
    await page.mouse.down(); await page.mouse.move(box.x + box.width + 20, box.y + 400 * box.height / 800, { steps: 4 }); await page.mouse.up()
    await until(async () => remote.evaluate(() => (window as any).events.some((e: any) => e.type === 'pointerup' && e.x >= 1278)))
    await page.mouse.move(box.x + 600 * box.width / 1280, box.y + 500 * box.height / 800)
    await page.mouse.wheel(0, 340)
    await until(async () => remote.evaluate(() => scrollY > 100))
    await clickRemote(400, 400); await page.keyboard.down('Shift')
    await view.locator('#input').evaluate(node => (node as HTMLElement).blur())
    await until(async () => remote.evaluate(() => (window as any).events.some((e: any) => e.type === 'keyup' && e.key === 'Shift')))
    assert.match((await view.locator('#mode').getAttribute('title'))!, /agent can only view/)
    assert.match((await view.locator('#mode').getAttribute('aria-label'))!, /same Halo chat/)
  })
  await t.test('unsupported native file chooser is surfaced as a persistent error', async () => {
    await remote.evaluate(() => document.querySelector<HTMLInputElement>('#upload')!.click())
    await until(async () => (await view.locator('#error').innerText()).includes('Native dialogs, uploads'))
  })

  const secondPage = await context.newPage(); await secondPage.goto(f.origin + '/host'); const second = await frame(secondPage)
  await t.test('second viewer cannot steal control or send a queued action; no focus-chat', async () => {
    await mode(second, 'Read-only · watching')
    const before = f.frames.length
    await second.locator('#new-tab').click()
    await until(async () => (await second.locator('#error').innerText()).includes('Another viewer'))
    await second.locator('#screen').click({ position: { x: 100, y: 100 } })
    await until(() => f.frames.slice(before).filter((frame: any) => frame.type === 'takeover').length === 2)
    assert.equal(f.frames.slice(before).some((frame: any) => frame.type === 'new-tab' || frame.type === 'input'), false)
    await mode(second, 'Read-only · watching')
    const sent = await page.evaluate(() => (window as any).hostFrames)
    assert.deepEqual(sent.filter((f: any) => f.type !== 'ready'), [])
    assert.equal(await view.getByRole('button', { name: 'Done', exact: true }).count(), 0)
  })
  await t.test('same-session action after a new human turn automatically returns 10 → 2', async () => {
    const before = f.frames.length
    const resumed = await f.command('press', { key: 'Escape' }, 'turn2')
    assert.equal(resumed.body.result.status, 'ok')
    await mode(view, '2 fps'); await mode(second, '2 fps')
    assert.match(await view.locator('#mode').innerText(), /Agent is driving/)
    assert.equal(f.frames.slice(before).some((frame: any) => frame.type === 'input'), false)
    assert.doesNotMatch(await view.locator('#error').innerText(), /Another viewer/)
  })
  await secondPage.close()
  await t.test('hidden viewer closes stream; show and transport loss reconnect without taking control', async () => {
    await view.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await until(() => f.liveSockets === 0)
    assert.match(await view.locator('#mode').innerText(), /stream paused/)
    await view.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await mode(view, '2 fps'); await until(async () => view.locator('#empty').isHidden())
    const before = f.connections; f.breakConnections()
    await until(() => f.connections > before); await mode(view, '2 fps')
    assert.match(await view.locator('#mode').innerText(), /Agent is driving/)
  })
  await t.test('keyboard and every shell control auto-take over before acting', async () => {
    let turn = 2
    const resume = async () => { await f.command('press', { key: 'Escape' }, `turn${++turn}`); await mode(view, '2 fps') }
    const act = async (type: string, action: () => Promise<unknown>) => {
      const start = f.frames.length
      await action(); await mode(view, '10 fps')
      await until(() => f.frames.slice(start).some((frame: any) => frame.type === type))
      const sent = f.frames.slice(start).filter((frame: any) => frame.type !== 'frame-ack') as any[]
      assert.equal(sent[0].type, 'takeover'); assert.equal(sent[1].type, type)
    }
    await act('input', async () => { await view.locator('#input').focus(); await page.keyboard.press('ArrowDown') })
    await resume()
    for (const value of ['file:///fixture', 'chrome://settings', 'javascript:1', 'data:text/plain,test', 'two words']) {
      const start = f.frames.length
      await view.locator('#address').fill(value); await view.locator('#address').press('Enter')
      assert.match(await view.locator('#error').innerText(), /http or https/, JSON.stringify({ value, address: await view.locator('#address').inputValue(), frames: f.frames.slice(start) }))
      assert.equal(f.frames.slice(start).some((frame: any) => frame.type === 'navigate' || frame.type === 'takeover'), false)
    }
    await act('navigate', async () => { await view.locator('#address').fill(f.origin + '/target?next'); await view.locator('#address').press('Enter') })
    await until(() => remote.url().endsWith('?next')); await resume()
    await act('back', () => view.locator('#back').click()); await until(() => remote.url().endsWith('/target')); await resume()
    await act('forward', () => view.locator('#forward').click()); await until(() => remote.url().endsWith('?next')); await resume()
    let loads = 0; remote.on('domcontentloaded', () => loads++)
    await act('reload', () => view.locator('#reload').click()); await until(() => loads > 0); await resume()
    await act('new-tab', () => view.locator('#new-tab').click())
    await until(async () => view.locator('#tabs').isVisible())
    assert.equal(await view.locator('#address').evaluate(node => document.activeElement === node), true)
    await until(async () => await view.locator('#address').inputValue() === '')
    await resume()
    await act('select-tab', () => view.locator('#tabs button[aria-current="false"]').click())
    await until(async () => (await view.locator('#address').inputValue()).endsWith('?next')); await resume()
    await act('close-tab', () => view.locator('#tabs > div').filter({ has: view.locator('[aria-current="true"]') }).getByRole('button', { name: 'Close tab' }).click())
    await until(async () => view.locator('#tabs').isHidden())
    assert.equal(f.browserContexts[0].pages().length, 1)
    await resume()
  })
  await t.test('theme/language updates, iframe remount and unbound chat context', async () => {
    await page.evaluate(() => {
      const target = document.querySelector('iframe')!.contentWindow!
      target.postMessage({ haloExt: 1, type: 'theme', theme: 'light', themeVars: { background: '#fafafa' } }, location.origin)
      target.postMessage({ haloExt: 1, type: 'lang', lang: 'zh' }, location.origin)
    })
    await until(async () => (await view.locator('#new-tab').getAttribute('title')) === '新标签页')
    assert.equal(await view.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(250, 250, 250)')
    await page.reload(); const remounted = await frame(page); await mode(remounted, '2 fps')
    await page.evaluate(init => {
      delete init.context.sessionId
      document.querySelector('iframe')!.contentWindow!.postMessage(init, location.origin)
    }, f.init)
    assert.equal(await remounted.locator('#chat').count(), 0)
    await mode(remounted, '2 fps')
  })
  assert.deepEqual(errors, [])
})
