#!/usr/bin/env node
// usage: node scripts/pack.mjs extensions/glb   → dist/glb-1.0.0.zip
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = resolve(process.argv[2] ?? '');
if (!existsSync(`${dir}/halo-extension.json`)) { console.error('usage: pack.mjs extensions/<id>  (needs halo-extension.json)'); process.exit(1); }
const m = JSON.parse(readFileSync(`${dir}/halo-extension.json`, 'utf8'));
if (m.id !== basename(dir)) { console.error(`manifest id "${m.id}" != directory "${basename(dir)}"`); process.exit(1); }
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(m.version)) { console.error(`bad version "${m.version}"`); process.exit(1); }
if (!existsSync(`${dir}/${m.entry}`)) { console.error(`entry "${m.entry}" not found`); process.exit(1); }
mkdirSync('dist', { recursive: true });
const out = resolve(`dist/${m.id}-${m.version}.zip`);
// zip contents at the archive root (no wrapper dir) — matches what the installer expects; -X drops extra attrs, -r recursive
execFileSync('zip', ['-r', '-X', '-q', out, '.', '-x', 'fetch-deps.sh', 'build.sh', 'node_modules/*', '.DS_Store'], { cwd: dir, stdio: 'inherit' });
console.log(out);
