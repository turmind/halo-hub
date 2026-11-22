#!/usr/bin/env node
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.some((arg, i) => i % 2 === 0 && !['--platform', '--native-dir'].includes(arg)) || args.length % 2) throw new Error('usage: build.mjs [--platform <os-arch>] [--native-dir <platform outputs>]');
const platform = option('--platform') ?? `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
if (!['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win-x64'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
// F can supply its compiled, platform-specific runtime files here; never copy native source/fixtures.
const nativeDir = option('--native-dir') ? resolve(option('--native-dir')) : join(root, 'backend/src/signin-import/native/dist', platform);
const hasNative = await access(nativeDir).then(() => true, () => false);
if (option('--native-dir') && !hasNative) throw new Error('Native output directory does not exist');
if (platform !== 'linux-x64' && !hasNative) throw new Error(`Platform ${platform} is gated on F native outputs and native acceptance; supply --native-dir after verification.`);
const stage = join(root, '.staging/build');
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, 'backend/node_modules'), { recursive: true });
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await rm(join(root, 'dist'), { recursive: true, force: true });
await build({ entryPoints: [join(root, 'src/viewer.ts')], outfile: join(root, 'dist/viewer.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none' });
execFileSync(process.execPath, [join(root, 'node_modules/@tailwindcss/cli/dist/index.mjs'), '-i', join(root, 'src/viewer.css'), '-o', join(root, 'dist/viewer.css'), '--minify'], { cwd: root, stdio: 'inherit' });
await cp(join(root, 'contracts/halo-core/LICENSE'), join(root, 'dist/halo-core-LICENSE'));
await build({ entryPoints: [join(root, 'backend/src/index.ts')], outfile: join(stage, 'backend/index.cjs'), bundle: true, format: 'cjs', platform: 'node', target: 'node22', external: Object.keys(pkg.dependencies), legalComments: 'none' });
const copied = new Map();
async function copyDependency(name, from) {
  const require = createRequire(join(from, 'package.json'));
  let manifest;
  try { manifest = require.resolve(`${name}/package.json`); }
  catch {
    let directory = dirname(require.resolve(name));
    while (true) {
      const candidate = join(directory, 'package.json');
      const data = await readFile(candidate, 'utf8').then(JSON.parse, () => null);
      if (data?.name === name) { manifest = candidate; break; }
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`Cannot locate runtime dependency: ${name}`);
      directory = parent;
    }
  }
  const source = dirname(manifest);
  const dependency = JSON.parse(await readFile(manifest, 'utf8'));
  if (copied.has(name)) {
    if (copied.get(name) !== dependency.version) throw new Error(`Conflicting runtime dependency versions: ${name}`);
    return;
  }
  copied.set(name, dependency.version);
  await cp(source, join(stage, 'backend/node_modules', name), { recursive: true, dereference: true, filter: path => !path.slice(source.length).split(/[\\/]/).includes('node_modules') });
  for (const child of Object.keys(dependency.dependencies ?? {})) await copyDependency(child, source);
  // Playwright's optional fsevents is macOS-only and not needed for browser automation.
}
for (const name of Object.keys(pkg.dependencies)) await copyDependency(name, root);
if (hasNative) await cp(nativeDir, join(stage, 'backend/native'), { recursive: true, dereference: true });
// Only disposable outputs are replaced. In particular, never remove backend/ (it owns backend/src).
for (const output of ['node_modules', 'native', 'index.cjs']) {
  await rm(join(root, 'backend', output), { recursive: true, force: true });
  const source = join(stage, 'backend', output);
  if (await access(source).then(() => true, () => false)) await cp(source, join(root, 'backend', output), { recursive: true });
}
console.log(`[BrowserBuild] ${platform}: viewer + backend + ${copied.size} runtime packages${hasNative ? ' + native outputs' : ' (sign-in integration pending F)'}`);
