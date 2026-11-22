import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitViewport, remotePoint } from '../../src/geometry.js'
import { BROWSER_VIEWPORT } from '../../backend/src/protocol.js'

test('letterboxing fits landscape and tall hosts without stretching', () => {
  assert.deepEqual(fitViewport(1000, 800, BROWSER_VIEWPORT), { scale: 0.78125, width: 1000, height: 625, left: 0, top: 87.5 })
  assert.deepEqual(fitViewport(1600, 800, BROWSER_VIEWPORT), { scale: 1, width: 1280, height: 800, left: 160, top: 0 })
})
test('input uses CSS bounds independent of DPR and clamps captured drags only', () => {
  const rect = { left: 40, top: 90, width: 640, height: 400 }
  assert.deepEqual(remotePoint(360, 290, rect, BROWSER_VIEWPORT), { x: 640, y: 400 })
  assert.equal(remotePoint(30, 80, rect, BROWSER_VIEWPORT), null)
  assert.deepEqual(remotePoint(1000, -5, rect, BROWSER_VIEWPORT, true), { x: 1279, y: 0 })
  assert.equal(remotePoint(0, 0, { ...rect, width: 0 }, BROWSER_VIEWPORT), null)
})
