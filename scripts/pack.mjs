#!/usr/bin/env node
// usage: node scripts/pack.mjs extensions/glb   → dist/glb-1.0.0.zip
//        node scripts/pack.mjs models           → dist/models-<YYYY.MM.DD>.zip (today, UTC)
import { readFileSync, readdirSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Manifest rules copied from the Halo server (halo-agent packages/server/src/extensions/registry.ts, parseManifest +
// parseSettings — the source of truth; copy changes from there). A host lists a manifest that breaks one as an error
// and never loads the extension, so it is refused here instead of being packed.
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const FILE_EXT_RE = /^\.[a-z0-9]+$/;
const CAPABILITIES = ['save', 'media', 'transcribe', 'fs-read', 'stt-local'];
const PLATFORMS = ['web', 'desktop-mac', 'desktop-win', 'desktop-linux'];
const SETTING_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SETTING_TYPES = ['string', 'int', 'float', 'boolean', 'enum'];

const dir = resolve(process.argv[2] ?? '');

if (basename(dir) === 'models' && !existsSync(`${dir}/halo-extension.json`)) packModels();
else packExtension();

function packExtension() {
  if (!existsSync(`${dir}/halo-extension.json`)) { console.error('usage: pack.mjs extensions/<id>  (needs halo-extension.json) | pack.mjs models'); process.exit(1); }
  let m;
  try { m = JSON.parse(readFileSync(`${dir}/halo-extension.json`, 'utf8')); } catch (e) { console.error(`halo-extension.json unreadable: ${e.message}`); process.exit(1); }
  const bad = manifestError(m);
  if (bad) { console.error(`${basename(dir)}/halo-extension.json: ${bad}`); process.exit(1); }
  mkdirSync('dist', { recursive: true });
  const out = resolve(`dist/${m.id}-${m.version}.zip`);
  // zip contents at the archive root (no wrapper dir) — matches what the installer expects; -X drops extra attrs, -r recursive.
  // Build inputs (src/, package*.json, build.sh, fetch-deps.sh, node_modules/) stay out of the zip.
  execFileSync('zip', ['-r', '-X', '-q', out, '.', '-x', 'fetch-deps.sh', 'build.sh', 'node_modules/*', 'src/*', 'package.json', 'package-lock.json', '.DS_Store'], { cwd: dir, stdio: 'inherit' });
  console.log(out);
}

/** First rule the manifest breaks, in registry.ts order (same wording as the host's error row), or null. */
function manifestError(m) {
  const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
  if (!isObj(m)) return 'manifest must be a JSON object';
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return `id must match ${ID_RE.source}`;
  if (m.id !== basename(dir)) return `id mismatch: manifest "${m.id}" vs directory "${basename(dir)}"`;
  if (typeof m.name !== 'string' || m.name.trim() === '' || m.name.length > 64) return 'name must be a non-empty string (≤ 64 chars)';
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) return 'version must be semver (x.y.z[-pre])';
  if (m.description !== undefined && (typeof m.description !== 'string' || m.description.length > 200)) {
    return `description must be a string (≤ 200 chars)${typeof m.description === 'string' ? `, has ${m.description.length}` : ''}`;
  }
  if (m.activity !== undefined) {
    const a = m.activity;
    if (!isObj(a)) return 'activity must be an object';
    if (a.icon !== undefined) {
      if (typeof a.icon !== 'string' || a.icon === '' || a.icon.startsWith('/') || a.icon.split(/[\\/]/).includes('..') || !/\.(svg|png)$/i.test(a.icon)) return 'activity.icon must be a relative .svg or .png path inside the extension directory';
      if (!isFile(`${dir}/${a.icon}`)) return `activity icon not found: ${a.icon}`;
    }
    for (const k of ['title', 'title_zh']) if (a[k] !== undefined && (typeof a[k] !== 'string' || a[k].trim() === '' || a[k].length > 64)) return `activity.${k} must be a non-empty string (≤ 64 chars)`;
    for (const k of ['description', 'description_zh']) if (a[k] !== undefined && (typeof a[k] !== 'string' || a[k].length > 200)) return `activity.${k} must be a string (≤ 200 chars)`;
    if (a.order !== undefined && (!Number.isInteger(a.order) || a.order < 0 || a.order > 1000)) return 'activity.order must be an integer 0–1000';
  }
  if (m.chatbar !== undefined) {
    const c = m.chatbar;
    if (!isObj(c)) return 'chatbar must be an object';
    if (c.icon !== undefined) {
      if (typeof c.icon !== 'string' || c.icon === '' || c.icon.startsWith('/') || c.icon.split(/[\\/]/).includes('..') || !/\.(svg|png)$/i.test(c.icon)) return 'chatbar.icon must be a relative .svg or .png path inside the extension directory';
      if (!isFile(`${dir}/${c.icon}`)) return `chatbar icon not found: ${c.icon}`;
    }
    for (const k of ['title', 'title_zh']) if (c[k] !== undefined && (typeof c[k] !== 'string' || c[k].trim() === '' || c[k].length > 64)) return `chatbar.${k} must be a non-empty string (≤ 64 chars)`;
    if (c.height !== undefined && (!Number.isInteger(c.height) || c.height < 80 || c.height > 480)) return 'chatbar.height must be an integer 80–480';
    if (c.order !== undefined && (!Number.isInteger(c.order) || c.order < 0 || c.order > 1000)) return 'chatbar.order must be an integer 0–1000';
  }
  if (m.activity !== undefined || m.chatbar !== undefined) {
    if (!Array.isArray(m.extensions)) return 'extensions must be an array (empty is fine with activity or chatbar)';
  } else if (!Array.isArray(m.extensions) || m.extensions.length === 0) return 'extensions must be a non-empty array';
  for (const e of m.extensions) if (typeof e !== 'string' || !FILE_EXT_RE.test(e)) return `extensions entry "${e}" must look like ".glb" (lowercase, with dot)`;
  if (typeof m.entry !== 'string' || m.entry === '' || m.entry.startsWith('/') || m.entry.split(/[\\/]/).includes('..')) return 'entry must be a relative path inside the extension directory';
  if (!isFile(`${dir}/${m.entry}`)) return `entry not found: ${m.entry}`;
  if (m.priority !== undefined && m.priority !== 'default' && m.priority !== 'option') return 'priority must be "default" or "option"';
  if (m.capabilities !== undefined && !Array.isArray(m.capabilities)) return 'capabilities must be an array';
  for (const c of m.capabilities ?? []) if (!CAPABILITIES.includes(c)) return `unknown capability: ${c}`;
  if (m.bundle !== undefined && typeof m.bundle !== 'boolean') return 'bundle must be a boolean';
  if (m.bundle === true && m.capabilities?.includes('save')) return 'bundle extensions cannot declare save';
  if (m.platforms !== undefined && (!Array.isArray(m.platforms) || m.platforms.length === 0)) return 'platforms must be a non-empty array';
  for (const p of m.platforms ?? []) if (!PLATFORMS.includes(p)) return `unknown platform: ${p}`;
  if (m.settings !== undefined) {
    if (!isObj(m.settings)) return 'settings must be an object';
    const seen = new Set();
    for (const kind of ['params', 'secrets']) {
      if (m.settings[kind] === undefined) continue;
      if (!Array.isArray(m.settings[kind])) return `settings.${kind} must be an array`;
      for (const f of m.settings[kind]) {
        if (!isObj(f)) return `settings.${kind} entries must be objects`;
        if (typeof f.key !== 'string' || !SETTING_KEY_RE.test(f.key)) return `settings key "${f.key}" must match ${SETTING_KEY_RE.source}`;
        if (seen.has(f.key)) return `duplicate settings key: ${f.key}`;
        seen.add(f.key);
        for (const k of ['description', 'description_zh']) if (f[k] !== undefined && typeof f[k] !== 'string') return `settings ${f.key}.${k} must be a string`;
        if (f.default !== undefined && !['string', 'number', 'boolean'].includes(typeof f.default)) return `settings ${f.key}.default must be a scalar`;
        if (f.type !== undefined && !SETTING_TYPES.includes(f.type)) return `settings ${f.key}.type must be one of ${SETTING_TYPES.join('|')}`;
        if (f.options !== undefined && (!Array.isArray(f.options) || f.options.length === 0 || f.options.some((o) => typeof o !== 'string'))) return `settings ${f.key}.options must be a non-empty string array`;
        if (f.type === 'enum' && f.options === undefined) return `settings ${f.key}: type enum requires options`;
      }
    }
  }
  if (m.homepage !== undefined && (typeof m.homepage !== 'string' || !/^https?:\/\//.test(m.homepage))) return 'homepage must be an http(s) URL';
  if (m.license !== undefined && typeof m.license !== 'string') return 'license must be a string';
  return null;
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
