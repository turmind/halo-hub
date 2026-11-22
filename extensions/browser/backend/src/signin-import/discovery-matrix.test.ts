import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { browserRoots, discover } from './discovery.js'
import { home } from './fixtures.js'

for (const platform of ['darwin', 'win32', 'linux'] as const) test(`${platform} standard root descriptors enumerate all profiles without touching live home`, async () => {
  const f = await home(platform)
  try {
    if (platform === 'win32') {
      for (const pkg of ['TheBrowserCompany.Arc_fixture', 'Mozilla.Firefox_fixture']) await mkdir(join(f.machine.env.LOCALAPPDATA!, 'Packages', pkg), { recursive: true })
    }
    const roots = await browserRoots(f.machine)
    for (const root of roots) {
      for (const profile of ['Default', 'Second']) {
        const file = join(root.root, profile, root.family === 'chromium' ? 'Network/Cookies' : 'cookies.sqlite')
        await mkdir(dirname(file), { recursive: true }); await writeFile(file, '')
      }
      if (root.family === 'firefox') await writeFile(join(root.root, 'profiles.ini'), '[Profile0]\nName=Named profile\nIsRelative=1\nPath=Second\n')
    }
    const sources = await discover(f.machine)
    assert.equal(sources.length, roots.length * 2)
    assert.equal(new Set(sources.map(s => s.id)).size, sources.length)
    assert.ok(sources.filter(s => s.family === 'firefox').some(s => s.profile === 'Named profile'))
    if (platform === 'win32') { assert.ok(sources.some(s => s.browser === 'Arc')); assert.ok(sources.some(s => s.browser === 'Firefox MSIX')) }
    if (platform === 'linux') { assert.ok(sources.some(s => s.browser === 'Chromium Snap')); assert.ok(sources.some(s => s.browser === 'Firefox Flatpak')) }
    if (platform === 'darwin') assert.ok(sources.some(s => s.browser === 'Chrome Canary'))
  } finally { await f.close() }
})
