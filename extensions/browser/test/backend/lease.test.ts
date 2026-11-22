import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorkspaceBrowser } from '../../backend/src/workspace.js'
import { Hooks } from '../../backend/src/hooks.js'
import { fixtureLauncher, session } from './fixtures.js'
import { BROWSER_LIMITS } from '../../backend/src/protocol.js'

test('idle and unattended handoff leases expire with one-shot timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let expired = 0
  const hooks = new Hooks(() => {})
  const workspace = new WorkspaceBrowser('/manufactured/workspace', '/unused-fixture-no-launch', fixtureLauncher, hooks, () => {}, () => { expired++ })
  try {
    workspace.acquire(session()); assert.equal(workspace.busy, true)
    t.mock.timers.tick(BROWSER_LIMITS.idleLeaseMs - 1); assert.equal(expired, 0)
    t.mock.timers.tick(1); assert.equal(expired, 1)
    workspace.handoff(); t.mock.timers.tick(BROWSER_LIMITS.handoffTimeoutMs - 1); assert.equal(expired, 1)
    t.mock.timers.tick(1); assert.equal(expired, 2)
  } finally { await workspace.close(); hooks.close(); t.mock.timers.reset() }
})
