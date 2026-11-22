import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProfileStore } from '../../backend/src/profile-store.js'
import { fixture, fixtureLauncher, http, session } from './fixtures.js'

test('profile restore before navigation, persistent/session distinction, logout and no-op writes', async () => {
  const f = await fixture()
  try {
    const caller = session()
    const opened = await http(f.socket, caller, '/command', { id: 'seed', op: 'open', args: { url: f.origin + '/seed' } })
    assert.equal(opened.body.ok, true)
    const store = new ProfileStore(join(f.directory, 'data'), caller.projectId)
    const journal = join(store.directory, 'session-cookies.json')
    const before = await stat(journal)
    await store.checkpoint(f.contexts[0])
    assert.equal((await stat(journal)).mtimeMs, before.mtimeMs)
    assert.equal(before.mode & 0o777, 0o600)
    assert.equal((await stat(store.profile)).mode & 0o777, 0o700)
    await f.backend.close()
    const context = await fixtureLauncher(store.profile, new AbortController().signal, () => {})
    try {
      await store.restore(context)
      await context.pages()[0].goto(f.origin + '/check')
      assert.match(await context.pages()[0].locator('body').innerText(), /session-restored persistent-restored/)
      assert.equal((await context.cookies()).find(cookie => cookie.name === 'session')?.expires, -1)
      await context.pages()[0].goto(f.origin + '/logout')
      await store.checkpoint(context)
      assert.equal(await readFile(journal, 'utf8'), '[]')
    } finally { await context.close() }
  } finally { await f.close() }
})

test('partition site and both ancestor bits survive the session journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-partition-'))
  const store = new ProfileStore(directory, '/manufactured/partitions'); await store.init()
  let context = await fixtureLauncher(store.profile, new AbortController().signal, () => {})
  try {
    let cdp = await context.newCDPSession(context.pages()[0])
    await cdp.send('Network.setCookies', { cookies: [false, true].map(bit => ({ name: 'fixture-' + bit, value: 'manufactured-only', domain: '127.0.0.1', path: '/', secure: true, partitionKey: { topLevelSite: 'https://fixture.invalid', hasCrossSiteAncestor: bit } })) })
    await cdp.detach(); await store.checkpoint(context); await context.close()
    context = await fixtureLauncher(store.profile, new AbortController().signal, () => {})
    await store.restore(context); cdp = await context.newCDPSession(context.pages()[0])
    const { cookies } = await cdp.send('Storage.getCookies')
    assert.deepEqual(cookies.map(cookie => cookie.partitionKey?.hasCrossSiteAncestor).sort(), [false, true])
    assert.ok(cookies.every(cookie => cookie.session && cookie.partitionKey?.topLevelSite === 'https://fixture.invalid'))
    await cdp.detach()
  } finally { await context.close(); await rm(directory, { recursive: true, force: true }) }
})
