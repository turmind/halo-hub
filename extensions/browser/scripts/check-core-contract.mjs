import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const sourceArg = args.indexOf('--source')
if (sourceArg < 0 || !args[sourceArg + 1] || args.includes('--write') === args.includes('--check')) {
  console.error('Usage: check-core-contract.mjs --source <Halo checkout> --write|--check')
  process.exit(1)
}
const source = resolve(args[sourceArg + 1])
const target = fileURLToPath(new URL('../contracts/halo-core/', import.meta.url))
const names = ['extension-notices.ts', 'extension-frames.ts', 'extension-types.ts']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(join(source, 'packages/core/src/protocol', name))])))
if (args.includes('--write')) {
  await mkdir(target, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(target, name), bytes)
  const license = await readFile(join(source, 'LICENSE'))
  await writeFile(join(target, 'LICENSE'), license)
  const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
  await writeFile(join(target, 'snapshot.json'), JSON.stringify({ baseRevision, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])), licenseSha256: sha256(license) }, null, 2) + '\n')
} else {
  const pin = JSON.parse(await readFile(join(target, 'snapshot.json'), 'utf8'))
  for (const [name, bytes] of Object.entries(files)) {
    if (sha256(bytes) !== pin.files[name] || sha256(await readFile(join(target, name))) !== pin.files[name]) throw new Error(`Core contract drift: ${name}; coordinate regeneration after integration`)
  }
  if (sha256(await readFile(join(target, 'LICENSE'))) !== pin.licenseSha256) throw new Error('License snapshot drift')
}
console.log(`Core contract ${args.includes('--write') ? 'snapshotted' : 'verified'}: ${names.length} files`)
