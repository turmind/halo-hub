#!/usr/bin/env node
// usage: node scripts/pack.mjs extensions/glb   → dist/glb-1.0.0.zip
//        node scripts/pack.mjs models           → dist/models-<YYYY.MM.DD>.zip (today, UTC)
import { readFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = resolve(process.argv[2] ?? '');

if (basename(dir) === 'models' && !existsSync(`${dir}/halo-extension.json`)) packModels();
else packExtension();

function packExtension() {
  if (!existsSync(`${dir}/halo-extension.json`)) { console.error('usage: pack.mjs extensions/<id>  (needs halo-extension.json) | pack.mjs models'); process.exit(1); }
  const m = JSON.parse(readFileSync(`${dir}/halo-extension.json`, 'utf8'));
  if (m.id !== basename(dir)) { console.error(`manifest id "${m.id}" != directory "${basename(dir)}"`); process.exit(1); }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(m.version)) { console.error(`bad version "${m.version}"`); process.exit(1); }
  if (!existsSync(`${dir}/${m.entry}`)) { console.error(`entry "${m.entry}" not found`); process.exit(1); }
  mkdirSync('dist', { recursive: true });
  const out = resolve(`dist/${m.id}-${m.version}.zip`);
  // zip contents at the archive root (no wrapper dir) — matches what the installer expects; -X drops extra attrs, -r recursive.
  // Build inputs (src/, package*.json, build.sh, fetch-deps.sh, node_modules/) stay out of the zip.
  execFileSync('zip', ['-r', '-X', '-q', out, '.', '-x', 'fetch-deps.sh', 'build.sh', 'node_modules/*', 'src/*', 'package.json', 'package-lock.json', '.DS_Store'], { cwd: dir, stdio: 'inherit' });
  console.log(out);
}

// Model provider configs: every models/<id>.yaml, flat at the archive root.
// Pre-checks only what a mistake here would leak or break; `halo models
// install` is the authority (runtime known to that halo, revision, secrets).
function packModels() {
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
  if (files.length === 0) { console.error(`no .yaml in ${dir}`); process.exit(1); }
  for (const f of files) {
    const text = readFileSync(`${dir}/${f}`, 'utf8');
    const field = (k) => text.match(new RegExp(`^${k}:\\s*(\\S+)`, 'm'))?.[1];
    if (field('id') !== f.replace(/\.yaml$/, '')) { console.error(`${f}: top-level id "${field('id')}" != file name`); process.exit(1); }
    if (!/^\d{10}$/.test(field('revision') ?? '')) { console.error(`${f}: needs an integer revision (YYYYMMDDNN), bump it on every edit`); process.exit(1); }
    // A secrets[].default must be empty or a <<ENV_NAME>> placeholder — never a
    // credential. The secrets block = from `secrets:` to the next top-level key.
    const secrets = text.match(/^secrets:\n((?:[ \t#].*\n|\n)*)/m)?.[1] ?? '';
    for (const [, v] of secrets.matchAll(/^\s+default:\s*(.*)$/gm)) {
      const val = v.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
      if (val !== '' && !/^<<[A-Z_][A-Z0-9_]*>>$/.test(val)) { console.error(`${f}: secrets default "${val}" is not empty or <<ENV_NAME>>`); process.exit(1); }
    }
  }
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '.');
  mkdirSync('dist', { recursive: true });
  const out = resolve(`dist/models-${date}.zip`);
  rmSync(out, { force: true });
  execFileSync('zip', ['-X', '-q', out, ...files], { cwd: dir, stdio: 'inherit' });
  console.log(out);
}
