import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, symlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createBrowserLauncher } from '../../backend/src/browser-launcher.js'

test('production Linux launcher uses pinned data-dir revision and never a real browser profile', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-launcher-'))
  try {
    await mkdir(join(directory, 'browsers'))
    // Read-only installed test binary, no download and no real browser profile.
    await symlink(join(homedir(), '.cache/ms-playwright/chromium-1228'), join(directory, 'browsers/chromium-1228'))
    const launch = createBrowserLauncher(directory); const statuses: string[] = []
    const context = await launch(join(directory, 'profile'), new AbortController().signal, info => statuses.push(info.status))
    try { assert.match(context.browser()!.version(), /^149\./); assert.deepEqual(statuses, ['downloading', 'starting']) }
    finally { await context.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
