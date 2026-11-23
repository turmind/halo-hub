import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commitCookies } from '../../backend/src/signin-import/import-cookies.js'
import { host } from '../../backend/src/signin-import/fixtures.js'
import type { WorkspaceBrowser } from '../../backend/src/workspace.js'
import { fixture, http, session } from './fixtures.js'

test('active-worker reason uses the live tabs ID from the workspace commit boundary', async t => {
  const f = await fixture(); t.after(() => f.close())
  const caller = session()
  await http(f.socket, caller, '/command', { id: 'open', op: 'open', args: { url: f.origin + '/private/path?secret=hidden' } })
  const workspace = (f.backend as unknown as { workspaces: Map<string, WorkspaceBrowser> }).workspaces.get(caller.projectId)!
  const tab = workspace.state().tabs[0]; const page = f.contexts[0].pages()[0]
  const workerReady = page.waitForEvent('worker')
  await page.evaluate(() => { const worker = new Worker(URL.createObjectURL(new Blob(['onmessage = () => {}'], { type: 'text/javascript' }))); Object.assign(window, { fixtureWorker: worker }) })
  await workerReady
  workspace.pendingImport = true
  try {
    const bound: ReturnType<typeof host> = { ...host(), caller, withCommit: work => workspace.withCommit(caller, new AbortController().signal, work) }
    await assert.rejects(commitCookies(bound, [], bound.signal), error => {
      assert.ok(error instanceof Error); assert.ok(error.message.includes(`${tab.id} ${f.origin}`))
      assert.doesNotMatch(error.message, /private|secret|hidden/); return true
    })
    assert.equal(page.isClosed(), false)
  } finally { workspace.pendingImport = false }
})
