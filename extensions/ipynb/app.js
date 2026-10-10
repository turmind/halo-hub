import { ansiToFragment } from './ansi.js';
import { renderMarkdown, renderLatex, renderHtmlOutput, sanitizeSvg, highlight } from './markdown.js';
import { str, num, parseNotebook, serializeNotebook, splitLines, setKey, outputFrom, displayUpdate, appendStream, newCell, convertCell, wantsIds } from './notebook.js';
import { Kernel, jupyterStatus, kernelSpecs } from './kernel.js';

const post = (m, transfer) => parent.postMessage({ haloExt: 1, ...m }, '*', transfer);
const root = document.getElementById('root');

// ---- small helpers ---------------------------------------------------------------------------------------------------

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const WIDGET_MIME = 'application/vnd.jupyter.widget-view+json';
const IMG_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const B64 = /^[A-Za-z0-9+/=\s]+$/;

// ---- text outputs (collapsible) --------------------------------------------------------------------------------------

const PREVIEW_LINES = 24;
const PREVIEW_CHARS = 4000;

/** Index where the collapsed preview of `text` ends, or -1 when the whole text is short enough to show. */
function previewEnd(text) {
  let pos = 0, end = text.length;
  for (let i = 0; i < PREVIEW_LINES; i++) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) { pos = -1; break; }
    pos = nl + 1;
  }
  if (pos >= 0 && pos < text.length) end = pos;
  if (end > PREVIEW_CHARS) {
    end = PREVIEW_CHARS;
    const esc = text.lastIndexOf('\x1b', end);
    if (esc > end - 40 && !/[@-~]/.test(text.slice(esc + 2, end))) end = esc; // don't cut inside an ANSI sequence
  }
  return end >= text.length ? -1 : end;
}

/** Text with ANSI colors; long text starts collapsed (first lines only) with a "Show all" toggle. */
function textBlock(text, cls, ansi = true) {
  const box = el('div', 'txtbox');
  const pre = el('pre', `txt ${cls ?? ''}`);
  const fill = (t) => { if (ansi) pre.replaceChildren(ansiToFragment(t)); else pre.textContent = t; };
  box.append(pre);
  const end = previewEnd(text);
  if (end < 0) { fill(text); return box; }
  const lines = text.split('\n').length;
  const btn = el('button', 'more');
  btn.type = 'button';
  let open = false;
  const paint = () => {
    fill(open ? text : text.slice(0, end));
    pre.classList.toggle('open', open);
    btn.textContent = open ? t('less') : t('more', lines.toLocaleString(), fmtBytes(text.length));
  };
  btn.__paint = paint; // language switch
  btn.addEventListener('click', () => { open = !open; paint(); });
  paint();
  box.append(btn);
  return box;
}

// ---- outputs ---------------------------------------------------------------------------------------------------------

const note = (mime, fallback) => {
  const n = el('div', 'note', `[unsupported output: ${mime}]`);
  if (fallback) n.append(el('span', 'note-alt', ` — ${fallback.length > 160 ? fallback.slice(0, 160) + '…' : fallback}`));
  return n;
};

function imageOut(mime, data, meta) {
  const b64 = str(data);
  if (!B64.test(b64)) return null;
  const img = el('img', 'out-img');
  img.alt = 'notebook output';
  img.src = `data:${mime};base64,${b64.replace(/\s+/g, '')}`;
  applyImageMeta(img, meta?.[mime], meta);
  return img;
}

function svgOut(svg, meta) {
  const clean = sanitizeSvg(svg);
  if (!clean.trim()) return null;
  // An <img> keeps the SVG's own <style> (matplotlib emits `*{…}`) from leaking into the page and is inert by design.
  const img = el('img', 'out-img');
  img.alt = 'notebook output';
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}`;
  applyImageMeta(img, meta?.['image/svg+xml'], meta);
  return img;
}

function applyImageMeta(img, sizeMeta, meta) {
  if (sizeMeta?.width) img.setAttribute('width', String(num(sizeMeta.width)));
  if (sizeMeta?.height) img.setAttribute('height', String(num(sizeMeta.height)));
  // Transparent plots drawn for a light (or dark) page: give them that background, like Jupyter does.
  if (meta?.needs_background === 'light') img.classList.add('bg-light');
  else if (meta?.needs_background === 'dark') img.classList.add('bg-dark');
}

function jsonOut(value) {
  let text;
  try { text = JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value, null, 2); } catch { text = str(value); }
  const box = el('div', 'txtbox');
  const pre = el('pre', 'txt json');
  const html = highlight(text, 'json');
  if (html != null) { const code = el('code', 'hljs'); code.innerHTML = html; pre.append(code); } else pre.textContent = text;
  box.append(pre);
  return box;
}

/** Pick the richest representation we can render; returns an element (never null). */
function renderData(data, meta) {
  if (data[WIDGET_MIME] != null) return note(WIDGET_MIME, str(data['text/plain']));
  if (data['text/html'] != null) { const h = renderHtmlOutput(str(data['text/html'])); if (h) return h; }
  if (data['image/svg+xml'] != null) { const svg = svgOut(str(data['image/svg+xml']), meta); if (svg) return svg; }
  for (const m of IMG_MIMES) if (data[m] != null) { const img = imageOut(m, data[m], meta); if (img) return img; }
  if (data['text/markdown'] != null) { const box = el('div', 'out-md'); box.append(renderMarkdown(str(data['text/markdown']))); return box; }
  if (data['text/latex'] != null) return renderLatex(str(data['text/latex']));
  if (data['application/json'] != null) return jsonOut(data['application/json']);
  if (data['text/plain'] != null) return textBlock(str(data['text/plain']), 'plain');
  const first = Object.keys(data)[0];
  return note(first ?? 'empty output');
}

/** Merge consecutive stream outputs of the same name (Jupyter shows them as one block). */
function mergeStreams(outputs) {
  const out = [];
  for (const o of outputs) {
    const prev = out[out.length - 1];
    if (o?.output_type === 'stream' && prev?.output_type === 'stream' && prev.name === o.name) {
      out[out.length - 1] = { ...prev, text: str(prev.text) + str(o.text) };
    } else out.push(o);
  }
  return out;
}

function renderOutputs(cell) {
  const frag = document.createDocumentFragment();
  for (const o of mergeStreams(cell.outputs ?? [])) {
    const row = el('div', 'row outrow');
    const prompt = el('div', 'prompt');
    const body = el('div', 'body');
    row.append(prompt, body);
    switch (o?.output_type) {
      case 'stream':
        body.append(textBlock(str(o.text), o.name === 'stderr' ? 'stderr' : 'stdout'));
        break;
      case 'error': {
        const tb = Array.isArray(o.traceback) && o.traceback.length ? o.traceback.join('\n') : `${o.ename ?? 'Error'}: ${o.evalue ?? ''}`;
        body.append(textBlock(tb, 'err'));
        break;
      }
      case 'execute_result':
        prompt.textContent = `Out[${o.execution_count ?? cell.execution_count ?? ' '}]:`;
        prompt.classList.add('out');
        body.append(renderData(o.data ?? {}, o.metadata));
        break;
      case 'display_data':
      case 'update_display_data':
        body.append(renderData(o.data ?? {}, o.metadata));
        break;
      default:
        body.append(note(`output_type ${String(o?.output_type)}`));
    }
    frag.append(row);
  }
  return frag;
}

// ---- strings ---------------------------------------------------------------------------------------------------------

const T = {
  en: {
    cells: (n) => `${n} cell${n === 1 ? '' : 's'}`, kinds: (c, m, r) => `${c} code · ${m} markdown${r ? ` · ${r} raw` : ''}`,
    unknownKernel: 'Unknown kernel', empty: 'This notebook has no cells.', addFirst: '+ Add a cell',
    runTip: 'Run this cell (Ctrl+Enter); Shift+Enter runs and moves on', runAll: '▶▶ Run all',
    interrupt: '■ Interrupt', restart: '↻ Restart', kernelTip: 'Kernel',
    st: { none: 'no kernel', starting: 'starting', idle: 'idle', busy: 'busy', restarting: 'restarting', dead: 'dead', gone: 'shut down' },
    stGone: 'The kernel was shut down (idle too long or the server stopped it). Restart starts a new one.',
    stDead: 'Lost the connection to the kernel. Restart to start it again.',
    noJupyter: (err) => `Jupyter isn’t available on the Halo server${err ? ` (${err})` : ''}. `,
    install: ['To run cells, install it on the server yourself: ', '. '], setPath: ['If it is installed elsewhere, set its path in Settings → ', '.'],
    check: 'Check again',
    startFail: (m) => `Could not start the kernel: ${m}`, restartFail: (m) => `Restart failed: ${m}`,
    addAbove: 'Add a cell above', addBelow: 'Add a cell below', up: 'Move up', down: 'Move down', del: 'Delete cell',
    toCode: 'Code', toMd: 'Markdown', toRaw: 'Raw', typeTip: 'Cell type',
    clickToEdit: 'Empty markdown cell — click to edit', raw: 'Raw',
    more: (lines, size) => `Show all · ${lines} lines · ${size}`, less: 'Collapse',
  },
  zh: {
    cells: (n) => `${n} 个单元格`, kinds: (c, m, r) => `代码 ${c} · Markdown ${m}${r ? ` · Raw ${r}` : ''}`,
    unknownKernel: '未知内核', empty: '这个 notebook 里没有单元格。', addFirst: '+ 添加单元格',
    runTip: '运行这个单元格（Ctrl+Enter）；Shift+Enter 运行并跳到下一个', runAll: '▶▶ 全部运行',
    interrupt: '■ 中断', restart: '↻ 重启', kernelTip: '内核',
    st: { none: '未启动', starting: '启动中', idle: '空闲', busy: '运行中', restarting: '重启中', dead: '已断开', gone: '已关闭' },
    stGone: '内核已关闭（空闲太久或被服务器关掉）。点「重启」会启动一个新的。',
    stDead: '和内核的连接断了。点「重启」重新启动。',
    noJupyter: (err) => `Halo 服务器上没有可用的 Jupyter${err ? `（${err}）` : ''}。`,
    install: ['要运行单元格，请自行在服务器上安装：', '。'], setPath: ['若已装在其他位置，请在 设置 → ', ' 中填写它的路径。'],
    check: '重新检测',
    startFail: (m) => `内核启动失败：${m}`, restartFail: (m) => `重启失败：${m}`,
    addAbove: '在上方添加单元格', addBelow: '在下方添加单元格', up: '上移', down: '下移', del: '删除单元格',
    toCode: '代码', toMd: 'Markdown', toRaw: 'Raw', typeTip: '单元格类型',
    clickToEdit: '空的 Markdown 单元格 — 点击编辑', raw: 'Raw',
    more: (lines, size) => `显示全部 · ${lines} 行 · ${size}`, less: '收起',
  },
};
let lang = 'en';
const t = (k, ...a) => { const v = T[lang][k] ?? T.en[k]; return typeof v === 'function' ? v(...a) : v; };

// ---- cells -----------------------------------------------------------------------------------------------------------

let notebookLang = 'python';

function cellLanguage(src) {
  const magic = /^%%(\w+)/.exec(src)?.[1]?.toLowerCase();
  if (magic === 'html') return 'xml';
  if (magic && highlight('', magic) !== null) return magic;
  return notebookLang;
}

const isCell = (d) => d !== null && typeof d === 'object' && !Array.isArray(d);
const kindOf = (d) => (d?.cell_type === 'code' || d?.cell_type === 'markdown' ? d.cell_type : 'raw');

function inPrompt(c) {
  const n = c.running ? '*' : c.data.execution_count ?? ' ';
  return `In [${n}]:`;
}

/** The rows of a cell; `editor` (a container element) replaces the source view while the cell is being edited. */
function renderCell(c, editor) {
  const cell = isCell(c.data) ? c.data : {};
  const frag = document.createDocumentFragment();
  const src = str(cell.source);
  const kind = kindOf(cell);
  c.prompt = c.outs = null;
  if (kind === 'markdown') {
    const row = el('div', 'row inrow');
    const body = el('div', 'body');
    if (editor) body.append(editor);
    else if (src.trim()) body.append(renderMarkdown(src, cell.attachments));
    else body.append(el('div', 'md md-empty', t('clickToEdit')));
    row.append(el('div', 'prompt'), body);
    frag.append(row);
  } else if (kind === 'code') {
    const row = el('div', 'row inrow');
    const prompt = el('div', `prompt in${c.running ? ' running' : ''}`, inPrompt(c));
    const body = el('div', 'body');
    if (editor) body.append(editor);
    else {
      const pre = el('pre', 'src');
      const code = el('code', 'hljs');
      const html = highlight(src, cellLanguage(src));
      if (html != null) code.innerHTML = html; else code.textContent = src;
      pre.append(code);
      body.append(pre);
    }
    row.append(prompt, body);
    const outs = el('div', 'outs');
    outs.append(renderOutputs(cell));
    c.prompt = prompt;
    c.outs = outs;
    frag.append(row, outs);
  } else {
    const row = el('div', 'row inrow');
    const body = el('div', 'body');
    body.append(editor ?? el('pre', 'raw', src));
    row.append(el('div', 'prompt', t('raw')), body);
    frag.append(row);
  }
  return frag;
}

// Rough height of a not-yet-rendered cell, so the scrollbar and jump positions are plausible before content exists.
function estimateHeight(cell) {
  const src = str(cell?.source);
  const lines = src.split('\n').length;
  if (cell?.cell_type === 'markdown') return 24 + Math.min(lines, 60) * 22;
  let h = 24 + Math.min(lines, 80) * 19;
  for (const o of cell?.outputs ?? []) h += o?.data?.['image/png'] || o?.data?.['image/jpeg'] || o?.data?.['image/svg+xml'] ? 300 : 40;
  return h;
}

// ---- notebook --------------------------------------------------------------------------------------------------------

let doc = null;            // the parsed notebook; doc.cells is rebuilt from `cells` when serializing
let cells = [];            // [{ data, el, box, done, running }] in notebook order; data is the nbformat cell (kept as-is)
let observer = null;
let idleHandle = null;
let fillPos = 0;
let bar = null;            // sticky header
let list = null;           // main.nb
let sel = null;            // selected cell
let editing = null;        // { c, view } — the one cell with a mounted editor

const idle = window.requestIdleCallback ?? ((cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 30));
const cancelIdle = window.cancelIdleCallback ?? clearTimeout;

function paint(c) {
  try {
    c.box.replaceChildren(renderCell(c, editing?.c === c ? editing.host : null));
  } catch (err) {
    c.box.replaceChildren(el('div', 'note', `[could not render this cell: ${err instanceof Error ? err.message : String(err)}]`));
  }
}

function renderNow(c) {
  if (c.done) return;
  c.done = true;
  observer?.unobserve(c.el);
  // A cell wholly above the viewport changes height when it goes from placeholder to content, which would shove what
  // the reader is looking at: measure, render, and scroll by the difference (native scroll anchoring is off, see style.css).
  const r = c.el.getBoundingClientRect();
  const above = r.bottom <= (bar?.offsetHeight ?? 0);
  c.el.style.minHeight = '';
  paint(c);
  if (above) {
    const delta = c.el.getBoundingClientRect().height - r.height;
    if (delta) window.scrollBy(0, delta);
  }
}

// After the cells near the viewport are in, keep rendering the rest in idle slices so in-page find (Ctrl+F) and
// anchor jumps work on the whole notebook without ever blocking a frame for long.
function fillRest() {
  idleHandle = idle((dl) => {
    do { while (fillPos < cells.length && cells[fillPos].done) fillPos++; if (fillPos < cells.length) renderNow(cells[fillPos]); } while (fillPos < cells.length && dl.timeRemaining() > 4);
    if (fillPos < cells.length) fillRest(); else idleHandle = null;
  }, { timeout: 1000 });
}

function teardown() {
  stopEditing(false);
  observer?.disconnect();
  observer = null;
  if (idleHandle != null) cancelIdle(idleHandle);
  idleHandle = null;
  cells = [];
  sel = null;
  tools.remove();
  fillPos = 0;
}

function captureAnchor() {
  const top = bar?.offsetHeight ?? 0;
  for (let i = 0; i < cells.length; i++) {
    const r = cells[i].el.getBoundingClientRect();
    if (r.bottom > top + 1) return { i, id: cells[i].data?.id, off: top - r.top };
  }
  return null;
}

function kernelLabel(nb) {
  const ks = nb.metadata?.kernelspec;
  const li = nb.metadata?.language_info;
  const lang = li?.name ? `${li.name}${li.version ? ' ' + li.version : ''}` : ks?.language;
  const kernel = ks?.display_name || ks?.name;
  return [kernel, lang && lang !== kernel ? lang : null].filter(Boolean).join(' · ') || t('unknownKernel');
}

function setNotebookLang() {
  notebookLang = (doc.metadata?.kernelspec?.language || doc.metadata?.language_info?.name || 'python').toLowerCase();
  if (notebookLang === 'ir') notebookLang = 'r';
}

function makeCell(data) {
  const shell = el('section', `cell ${kindOf(data)}`);
  const box = el('div', 'cbox');
  shell.append(box);
  const c = { data, el: shell, box, done: false, running: false };
  shell.__cell = c;
  shell.style.minHeight = `${estimateHeight(data)}px`;
  return c;
}

function renderBar() {
  if (!bar || !doc) return;
  const counts = { code: 0, markdown: 0, raw: 0 };
  for (const c of cells) counts[kindOf(c.data)]++;
  const total = cells.length;
  const parts = [t('cells', total)];
  if (total) parts.push(t('kinds', counts.code, counts.markdown, counts.raw));
  bar.querySelector('.kernel').textContent = kernelLabel(doc);
  bar.querySelector('.count').textContent = parts.join(' — ');
  list.querySelector('.empty')?.remove();
  if (!total) {
    const box = el('div', 'empty');
    const add = el('button', 'btn', t('addFirst'));
    add.type = 'button';
    add.addEventListener('click', () => insertCell(0, 'code'));
    box.append(el('div', null, t('empty')), add);
    list.append(box);
  }
}

function show(nb, anchor) {
  teardown();
  doc = nb;
  setNotebookLang();
  list = el('main', 'nb');
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) renderNow(e.target.__cell);
  }, { rootMargin: '1500px 0px' });

  for (const data of nb.cells) {
    const c = makeCell(data);
    cells.push(c);
    list.append(c.el);
  }

  bar = el('header', 'bar');
  bar.append(el('span', 'kernel'), el('span', 'count'), el('span', 'grow'), kbox);
  root.replaceChildren(bar, list);
  renderBar();
  renderKernel();

  // Render what is around the previous scroll position first, then observe everything else.
  if (anchor && cells.length) {
    // nbformat 4.5 cells carry an id: follow the cell even when cells were inserted or removed above it.
    const byId = anchor.id != null ? cells.findIndex((c) => c.data?.id === anchor.id) : -1;
    const i = Math.min(byId >= 0 ? byId : anchor.i, cells.length - 1);
    for (let k = Math.max(0, i - 2); k <= Math.min(cells.length - 1, i + 6); k++) renderNow(cells[k]);
    window.scrollTo(0, Math.max(0, cells[i].el.offsetTop + anchor.off - (bar.offsetHeight)));
  }
  for (const c of cells) if (!c.done) observer.observe(c.el);
  if (cells.length) fillRest();
}

function fail(message) {
  teardown();
  doc = null;
  baseline = null;
  const box = el('div', 'fail');
  box.append(el('strong', null, 'Cannot display this notebook'), el('p', null, message));
  root.replaceChildren(box);
  post({ type: 'error', message });
}

function problemWith(nb) {
  if (nb === null || typeof nb !== 'object' || Array.isArray(nb)) return 'Not a Jupyter notebook: the top-level JSON value is not an object.';
  if (nb.worksheets || (typeof num(nb.nbformat) === 'number' && num(nb.nbformat) < 4)) {
    return `This is an nbformat ${nb.nbformat ?? 3} notebook; only nbformat 4 is supported. Upgrade it with "jupyter nbconvert --to notebook --inplace <file>".`;
  }
  if (!Array.isArray(nb.cells)) return 'Not a Jupyter notebook: there is no "cells" list.';
  return null;
}

// ---- dirty / save ----------------------------------------------------------------------------------------------------
// baseline = the file as on disk (last load / last confirmed save). Every model change bumps `rev`. For notebooks up to
// a few MB "dirty" is exact — the serialized model differs from the baseline — so editing a cell back to what it was
// (or running nothing) leaves the tab clean; bigger ones count any change as dirty until saved.

const EXACT_MAX = 4 * 1024 * 1024;
let baseline = null;
let rev = 0, baseRev = 0;
let reported = false;        // the dirty state the host knows about
let checkTimer = null;
let inFlight = null;         // { text, rev } of the save the host is writing

const serialize = () => { doc.cells = cells.map((c) => c.data); return serializeNotebook(doc); };

function reportDirty(dirty) {
  if (dirty === reported) return;
  reported = dirty;
  post({ type: 'dirty', dirty });
}

function checkDirty() {
  checkTimer = null;
  if (!doc) return;
  if (rev === baseRev) return reportDirty(false);
  reportDirty(baseline != null && baseline.length <= EXACT_MAX ? serialize() !== baseline : true);
}

function changed() {
  rev++;
  if (!reported && (baseline == null || baseline.length > EXACT_MAX)) reportDirty(true);
  clearTimeout(checkTimer);
  checkTimer = setTimeout(checkDirty, 200);
}

/** `force`: the host asked (it waits for an answer); Ctrl+S on a clean notebook writes nothing. */
function save(force) {
  if (!doc) return;
  clearTimeout(checkTimer);
  checkDirty();
  if (!reported && !force) return;
  const text = serialize();
  inFlight = { text, rev };
  const buffer = new TextEncoder().encode(text).buffer;
  post({ type: 'save', buffer }, [buffer]);
}

function onSaved() {
  if (inFlight) { baseline = inFlight.text; baseRev = inFlight.rev; inFlight = null; }
  reported = false; // the host clears its dirty flag on `saved`; edits made while the save was in flight count again
  checkDirty();
}

function load(buffer) {
  const text = new TextDecoder().decode(buffer);
  if (doc && text === baseline && rev === baseRev) return; // identical bytes: keep scroll position and expanded outputs
  reported = false; // the host clears its dirty flag on every load
  inFlight = null;
  clearTimeout(checkTimer);
  clearQueue();
  let nb;
  // An empty file (New File… → x.ipynb) is a new notebook; it stays empty on disk until a cell is added and saved.
  if (!text.trim()) nb = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 };
  else try { nb = parseNotebook(text); } catch (err) { return fail(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`); }
  const problem = problemWith(nb);
  if (problem) return fail(problem);
  const anchor = doc ? captureAnchor() : null;
  baseline = text;
  rev = baseRev = 0;
  show(nb, anchor);
}

// ---- editing ---------------------------------------------------------------------------------------------------------

let cm = null; // the CodeMirror bundle, imported on first edit
const cmLang = (c) => (kindOf(c.data) === 'markdown' ? 'markdown' : kindOf(c.data) === 'code' ? cellLanguage(str(c.data.source)) : 'plain');
const cellIndex = (c) => cells.indexOf(c);

function select(c, scroll = false) {
  if (sel === c) { if (scroll) c?.el.scrollIntoView({ block: 'nearest' }); return; }
  sel?.el.classList.remove('sel');
  sel = c;
  if (!c) { tools.remove(); return; }
  c.el.classList.add('sel');
  c.el.prepend(tools);
  renderTools();
  if (scroll) c.el.scrollIntoView({ block: 'nearest' });
}

async function edit(c, at) {
  if (!isCell(c.data)) return select(c);
  if (editing?.c === c) return editing.view.focus();
  stopEditing();
  select(c);
  renderNow(c);
  const token = {};
  const orig = c.data.source;
  editing = { c, host: el('div', 'editor'), view: null, token };
  paint(c);
  cm ??= await import('./vendor/codemirror.js');
  if (editing?.token !== token) return; // another cell was clicked while the bundle loaded
  const view = cm.mountEditor(editing.host, {
    doc: str(c.data.source),
    lang: cmLang(c),
    keys: [
      { key: 'Escape', run: () => { stopEditing(); return true; } },
      { key: 'Shift-Enter', run: () => { runAndNext(c); return true; } },
      { key: 'Mod-Enter', run: () => { runHere(c); return true; } },
    ],
    onChange: (text) => {
      // back to exactly the original text → the original value (a string stays a string), so the cell is untouched again
      c.data.source = text === str(orig) ? orig : splitLines(text);
      changed();
    },
    // focus moved elsewhere in the page → leave edit mode (markdown renders again); the whole frame losing focus
    // (typing in Halo's chat) keeps the editor, as activeElement stays on it
    onBlur: () => setTimeout(() => { if (editing?.c === c && !editing.host.contains(document.activeElement)) stopEditing(); }, 0),
  });
  editing.view = view;
  if (at) {
    const pos = view.posAtCoords(at);
    if (pos != null) view.dispatch({ selection: { anchor: pos } });
  }
  view.focus();
}

/** Leave edit mode: the editor goes away and the cell is rendered from the model again (markdown → HTML). */
function stopEditing(repaint = true) {
  if (!editing) return;
  const { c, view } = editing;
  editing = null;
  view?.destroy();
  if (repaint && cells.includes(c)) { paint(c); renderBar(); }
}

function insertCell(i, type, startEditing = true) {
  stopEditing();
  const ids = new Set(cells.map((c) => c.data?.id));
  let id = null;
  if (wantsIds(doc)) do id = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join(''); while (ids.has(id));
  const c = makeCell(newCell(type, id));
  c.done = true;
  c.el.style.minHeight = '';
  paint(c);
  list.insertBefore(c.el, cells[i]?.el ?? null);
  cells.splice(i, 0, c);
  changed();
  renderBar();
  if (startEditing) edit(c); else select(c, true);
  return c;
}

function deleteCell(c) {
  const i = cellIndex(c);
  if (i < 0) return;
  if (editing?.c === c) stopEditing(false);
  dequeue(c);
  observer?.unobserve(c.el);
  c.el.remove();
  cells.splice(i, 1);
  if (sel === c) { sel = null; select(cells[Math.min(i, cells.length - 1)] ?? null); }
  changed();
  renderBar();
}

function moveCell(c, d) {
  const i = cellIndex(c), j = i + d;
  if (i < 0 || j < 0 || j >= cells.length) return;
  stopEditing();
  cells.splice(i, 1);
  cells.splice(j, 0, c);
  list.insertBefore(c.el, cells[j + 1]?.el ?? null);
  changed();
  c.el.scrollIntoView({ block: 'nearest' });
}

function setType(c, type) {
  if (!isCell(c.data) || c.data.cell_type === type) return;
  stopEditing(false);
  dequeue(c);
  convertCell(c.data, type);
  c.el.className = `cell ${kindOf(c.data)}${sel === c ? ' sel' : ''}`;
  paint(c);
  renderTools();
  changed();
  renderBar();
}

// The toolbar of the selected cell. It sits outside the cell's rendered box, so repainting the cell keeps it.
const tools = el('div', 'ctools');
function toolButton(cls, onClick) {
  const b = el('button', `tb ${cls}`);
  b.type = 'button';
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor focused while clicking
  b.addEventListener('click', (e) => { e.stopPropagation(); if (sel) onClick(sel); });
  tools.append(b);
  return b;
}
const tRun = toolButton('t-run', (c) => runHere(c));
const tType = el('select', 'tb t-type');
tools.append(tType);
tType.addEventListener('change', () => { if (sel) setType(sel, tType.value); });
tType.addEventListener('click', (e) => e.stopPropagation());
const tUp = toolButton('t-up', (c) => moveCell(c, -1));
const tDown = toolButton('t-down', (c) => moveCell(c, 1));
const tAbove = toolButton('t-above', (c) => insertCell(cellIndex(c), 'code'));
const tBelow = toolButton('t-below', (c) => insertCell(cellIndex(c) + 1, 'code'));
const tDel = toolButton('t-del', (c) => deleteCell(c));

function renderTools() {
  const c = sel;
  if (!c) return;
  const k = isCell(c.data) ? kindOf(c.data) : null;
  tRun.textContent = '▶'; tRun.title = t('runTip'); tRun.hidden = k !== 'code' || !canRun();
  tType.replaceChildren(...[['code', t('toCode')], ['markdown', t('toMd')], ['raw', t('toRaw')]].map(([v, l]) => { const o = el('option', null, l); o.value = v; return o; }));
  tType.value = k === 'code' || k === 'markdown' ? k : 'raw';
  tType.disabled = !k;
  tType.title = t('typeTip');
  tUp.textContent = '↑'; tUp.title = t('up');
  tDown.textContent = '↓'; tDown.title = t('down');
  tAbove.textContent = '+↑'; tAbove.title = t('addAbove');
  tBelow.textContent = '+↓'; tBelow.title = t('addBelow');
  tDel.textContent = '🗑'; tDel.title = t('del');
}

/** Shift+Enter: run a code cell (when a kernel is there), render a markdown one, then on to the next cell. */
function runAndNext(c) {
  stopEditing();
  if (kindOf(c.data) === 'code' && canRun()) queueRun(c);
  const i = cellIndex(c);
  if (i === cells.length - 1) insertCell(i + 1, 'code');
  else { renderNow(cells[i + 1]); select(cells[i + 1], true); }
}

/** Ctrl/Cmd+Enter: run (or render) in place. */
function runHere(c) {
  stopEditing();
  select(c);
  if (kindOf(c.data) === 'code' && canRun()) queueRun(c);
}

// Clicks: on a cell's input (source / rendered markdown) → edit it there; anywhere else in a cell → select it.
function onListClick(e) {
  const shell = e.target.closest?.('section.cell');
  if (!shell || e.target.closest('.ctools')) return;
  const c = shell.__cell;
  if (editing?.c === c && e.target.closest('.editor')) return;
  const onInput = e.target.closest('.inrow') && !e.target.closest('a[href], button, summary, input');
  if (onInput && getSelection()?.isCollapsed !== false) edit(c, { x: e.clientX, y: e.clientY });
  else { if (editing?.c !== c) stopEditing(); select(c); }
}

// Command mode (a selected cell, no editor): Enter edits, Shift+Enter / Ctrl+Enter run like in Jupyter.
function onCommandKey(e) {
  if (!sel || editing || e.defaultPrevented || e.altKey) return;
  if (e.target instanceof Element && e.target.closest('input, select, textarea, button, a, [contenteditable="true"]')) return;
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (e.shiftKey) runAndNext(sel);
  else if (e.ctrlKey || e.metaKey) runHere(sel);
  else edit(sel);
}

// ---- running cells (init.jupyter hosts only) -------------------------------------------------------------------------

let jupyter = null;          // init.jupyter ({ projectId }) — absent on hosts without the Jupyter proxy
let filePath = null;         // init.file.path, workspace-relative
const ks = { enabled: null, avail: null, error: '', hint: '', specs: [], def: null, pick: null, status: 'none', kernel: null, checking: false };
let queue = [];              // cells waiting to run, in order
let current = null;          // { c, msgId, reply, idle, status, clear } — the cell the kernel is executing
const displays = new Map();  // display_id → [{ c, out }] for update_display_data

const canRun = () => !!jupyter && ks.avail === true && ks.specs.length > 0;
const specByName = (n) => ks.specs.find((s) => s.name === n);
/** The kernel to use: the one picked here, else the notebook's own if the server has it, else the server default. */
function kernelName() {
  if (ks.pick) return ks.pick;
  const own = doc?.metadata?.kernelspec?.name;
  return specByName(own) ? own : ks.def ?? ks.specs[0]?.name ?? null;
}

const kbox = el('span', 'kbox');
const kPick = el('select', 'kpick');
const kBadge = el('span', 'kbadge');
const kRunAll = el('button', 'btn');
const kInt = el('button', 'btn');
const kRestart = el('button', 'btn');
const kNote = el('span', 'knote');
const kCheck = el('button', 'btn');
for (const b of [kRunAll, kInt, kRestart, kCheck]) b.type = 'button';
kbox.append(kPick, kBadge, kRunAll, kInt, kRestart, kNote, kCheck);
kbox.hidden = true;

function renderKernel() {
  kbox.hidden = !jupyter || ks.enabled === false; // execution switched off on the server: no run controls, no notice
  if (kbox.hidden) return;
  const ready = canRun();
  kPick.hidden = kBadge.hidden = kRunAll.hidden = kInt.hidden = kRestart.hidden = !ready;
  kNote.hidden = ready && ks.status !== 'gone' && ks.status !== 'dead';
  kCheck.hidden = ks.avail !== false;
  if (ks.avail === false) {
    // Never installs anything: the server's hint is shown as a command for the user to run themselves.
    const code = (s) => el('code', null, s);
    kNote.replaceChildren(t('noJupyter', ks.error),
      ...(ks.hint ? [t('install')[0], code(ks.hint), t('install')[1]] : []), t('setPath')[0], code('general.jupyter.path'), t('setPath')[1]);
    kNote.className = 'knote warn';
    kCheck.textContent = t('check');
    kCheck.disabled = ks.checking;
    return;
  }
  if (!ready) { kNote.hidden = true; return; }
  const name = kernelName();
  if (kPick.options.length !== ks.specs.length) {
    kPick.replaceChildren(...ks.specs.map((s) => { const o = el('option', null, s.displayName || s.name); o.value = s.name; return o; }));
  }
  kPick.value = name;
  kPick.title = t('kernelTip');
  const st = ks.status;
  kBadge.textContent = t('st')[st] ?? st;
  kBadge.className = `kbadge s-${st}`;
  kRunAll.textContent = t('runAll');
  kInt.textContent = t('interrupt');
  kInt.disabled = !ks.kernel || !(current || queue.length);
  kRestart.textContent = t('restart');
  kRestart.disabled = !ks.kernel;
  kNote.className = 'knote warn';
  kNote.textContent = st === 'gone' ? t('stGone') : st === 'dead' ? t('stDead') : '';
}

/** Asks the server once — on open and on "Check again", never on a timer. */
async function initKernel() {
  ks.checking = true;
  renderKernel();
  try {
    const s = await jupyterStatus();
    ks.enabled = s?.enabled !== false;
    ks.avail = !!(s?.enabled && s?.available);
    ks.error = s?.error ?? '';
    ks.hint = s?.hint ?? '';
    if (ks.avail) {
      const sp = await kernelSpecs();
      ks.specs = Array.isArray(sp?.specs) ? sp.specs.filter((x) => x?.name) : [];
      ks.def = sp?.default ?? null;
    }
  } catch (e) {
    ks.avail = false;
    ks.error = e.message;
    ks.hint = e.hint ?? '';
  }
  ks.checking = false;
  renderKernel();
  renderTools();
}
kCheck.addEventListener('click', () => { if (!ks.checking) void initKernel(); });

/**
 * A kernel start refused with 503 means Jupyter went away or was switched off since the status check: show what the
 * status says now (the start error's hint wins when the probe still passes but the server can't start).
 */
async function startFailed(e, text) {
  if (e.status === 503) {
    if (!ks.kernel?.id) { ks.kernel = null; ks.status = 'none'; }
    await initKernel();
    if (ks.avail && e.hint) { ks.avail = false; ks.error = e.message; ks.hint = e.hint; renderKernel(); renderTools(); }
    if (!ks.avail) return;
  }
  kNote.hidden = false;
  kNote.textContent = text;
}

/** Picking another kernel: written into metadata.kernelspec (a change), and the running kernel is replaced on next run. */
kPick.addEventListener('change', () => {
  const s = specByName(kPick.value);
  if (!s || !doc) return;
  ks.pick = s.name;
  if (!isCell(doc.metadata)) setKey(doc, 'metadata', {});
  setKey(doc.metadata, 'kernelspec', { display_name: s.displayName || s.name, language: s.language || '', name: s.name });
  setNotebookLang();
  changed();
  renderBar();
  if (ks.kernel && ks.kernel.name !== s.name) dropKernel();
  renderKernel();
});

function dropKernel() {
  clearQueue();
  ks.kernel?.shutdown();
  ks.kernel = null;
  ks.status = 'none';
}

function newKernel() {
  const k = new Kernel({
    projectId: jupyter.projectId, path: filePath, name: kernelName(),
    onStatus: (s) => {
      if (ks.kernel !== k) return;
      ks.status = s;
      // the kernel died (Jupyter restarts it by itself) or is gone: nothing queued will be answered
      if (s === 'restarting' || s === 'dead' || s === 'gone') clearQueue();
      renderKernel();
    },
    onMessage: (msg) => { if (ks.kernel === k) onKernelMessage(msg); },
    // A new socket is a new Jupyter session: the reply to what was sent on the old one never comes. A kernel_info
    // request queues behind the running cell on the shell channel, so its reply says that cell is finished.
    onReconnect: () => { if (current && ks.kernel === k) current.sync = k.send('shell', 'kernel_info_request', {}); },
  });
  ks.kernel = k;
  return k;
}

function queueRun(c) {
  if (!canRun() || kindOf(c.data) !== 'code' || c.running) return;
  c.running = true;
  paintPrompt(c);
  queue.push(c);
  renderKernel();
  void pump();
}

function runAll() {
  stopEditing();
  for (const c of cells) if (kindOf(c.data) === 'code') queueRun(c);
}

let starting = false;
async function pump() {
  if (current || starting || !queue.length) return;
  if (ks.status === 'dead') return clearQueue(); // needs an explicit Restart
  if (!ks.kernel || ks.kernel.gone) {
    starting = true;
    try {
      if (ks.kernel?.gone) await ks.kernel.restart(); else await newKernel().start();
    } catch (e) {
      starting = false;
      clearQueue();
      ks.status = 'dead';
      renderKernel();
      return startFailed(e, t('startFail', e.message));
    }
    starting = false;
  }
  const c = queue.shift();
  if (!c || !cells.includes(c)) return pump();
  if (Array.isArray(c.data.outputs)) { c.data.outputs = []; forgetDisplays(c); }
  changed();
  paintOutputs(c);
  const msgId = ks.kernel.send('shell', 'execute_request', {
    code: str(c.data.source), silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true,
  });
  current = { c, msgId, reply: false, idle: false, status: null, clear: false, sync: null };
  renderKernel();
}

function finishCurrent() {
  const cur = current;
  current = null;
  cur.c.running = false;
  paintPrompt(cur.c);
  if (cur.status === 'error' || cur.status === 'aborted') clearQueue(); // like Jupyter: Run all stops at an error
  renderKernel();
  void pump();
}

function clearQueue() {
  for (const c of queue) { c.running = false; paintPrompt(c); }
  queue = [];
  if (current) { current.c.running = false; paintPrompt(current.c); current = null; }
  starting = false;
  renderKernel();
}

function dequeue(c) {
  queue = queue.filter((x) => x !== c);
  c.running = false;
}

function forgetDisplays(c) {
  for (const [id, list] of displays) {
    const keep = list.filter((x) => x.c !== c);
    if (keep.length) displays.set(id, keep); else displays.delete(id);
  }
}

function pushOutput(c, out, displayId) {
  const outs = c.data.outputs;
  if (!Array.isArray(outs)) return;
  if (current?.clear) { outs.length = 0; forgetDisplays(c); current.clear = false; }
  outs.push(out);
  if (displayId != null) displays.set(displayId, [...(displays.get(displayId) ?? []), { c, out }]);
  changed();
  paintOutputs(c);
}

function onKernelMessage(msg) {
  const type = msg.header?.msg_type;
  const parentId = msg.parent_header?.msg_id;
  const ct = msg.content ?? {};
  if (type === 'update_display_data') {
    // may target a display from any earlier cell
    const upd = displayUpdate(ct);
    for (const { c, out } of displays.get(ct.transient?.display_id) ?? []) {
      out.data = upd.data;
      out.metadata = upd.metadata;
      changed();
      paintOutputs(c);
    }
    return;
  }
  const cur = current;
  if (!cur) return;
  if (msg.channel === 'shell') {
    if (parentId === cur.msgId && type === 'execute_reply') {
      cur.reply = true;
      cur.status = ct.status;
      if (Array.isArray(cur.c.data.outputs)) { setKey(cur.c.data, 'execution_count', ct.execution_count ?? null); changed(); }
      if (cur.idle) finishCurrent();
    } else if (parentId === cur.sync && cur.sync) finishCurrent();
    return;
  }
  if (msg.channel !== 'iopub' || parentId !== cur.msgId) return;
  const c = cur.c;
  switch (type) {
    case 'status':
      if (ct.execution_state === 'idle') { cur.idle = true; if (cur.reply) finishCurrent(); }
      break;
    case 'execute_input': // the count arrives here first; a reply lost to a dropped socket would leave the cell without one
      if (Array.isArray(c.data.outputs) && ct.execution_count != null && c.data.execution_count !== ct.execution_count) { setKey(c.data, 'execution_count', ct.execution_count); changed(); }
      break;
    case 'stream': {
      const outs = c.data.outputs;
      const last = Array.isArray(outs) && !cur.clear ? outs[outs.length - 1] : null;
      if (last?.output_type === 'stream' && last.name === ct.name) { appendStream(last, str(ct.text)); changed(); paintOutputs(c); }
      else pushOutput(c, outputFrom('stream', ct));
      break;
    }
    case 'display_data':
    case 'execute_result':
    case 'error':
      pushOutput(c, outputFrom(type, ct), type === 'display_data' ? ct.transient?.display_id : null);
      break;
    case 'clear_output':
      if (ct.wait) cur.clear = true;
      else if (Array.isArray(c.data.outputs)) { c.data.outputs.length = 0; forgetDisplays(c); changed(); paintOutputs(c); }
      break;
  }
}

kRunAll.addEventListener('click', runAll);
kInt.addEventListener('click', () => { ks.kernel?.interrupt().catch((e) => { kNote.hidden = false; kNote.textContent = e.message; }); });
kRestart.addEventListener('click', async () => {
  const k = ks.kernel;
  if (!k) return;
  clearQueue();
  ks.status = 'starting';
  renderKernel();
  try { await k.restart(); } catch (e) { await startFailed(e, t('restartFail', e.message)); }
});
// Best effort; the server also shuts a kernel down 60 s after its last socket closes.
addEventListener('pagehide', () => ks.kernel?.shutdown());

// Repaint a cell's outputs / prompt without touching its input (an editor there keeps focus), once per frame.
const pendingPaint = new Set();
let paintFrame = 0;
function paintOutputs(c) {
  pendingPaint.add(c);
  paintFrame ||= requestAnimationFrame(() => {
    paintFrame = 0;
    for (const x of pendingPaint) if (x.done && x.outs) { x.outs.replaceChildren(renderOutputs(x.data)); paintPrompt(x); }
    pendingPaint.clear();
  });
}
function paintPrompt(c) {
  if (!c.prompt) return;
  c.prompt.textContent = inPrompt(c);
  c.prompt.classList.toggle('running', c.running);
}

// ---- host wiring -----------------------------------------------------------------------------------------------------

const setTheme = (th) => { document.documentElement.dataset.theme = th === 'light' ? 'light' : 'dark'; };
setTheme('dark'); // the admin's default until init says otherwise

function setLang(l) {
  lang = l === 'zh' ? 'zh' : 'en';
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  renderBar();
  renderKernel();
  renderTools();
  for (const n of document.querySelectorAll('.md-empty')) n.textContent = t('clickToEdit');
  for (const b of document.querySelectorAll('button.more')) b.__paint?.();
}

addEventListener('message', (e) => {
  if (e.source !== parent || e.data?.haloExt !== 1) return;
  const m = e.data;
  if (m.type === 'init') {
    setTheme(m.theme);
    filePath = m.file?.path ?? null;
    if (m.jupyter?.projectId && filePath && !jupyter) { jupyter = m.jupyter; void initKernel(); }
    setLang(m.lang);
  } else if (m.type === 'theme') setTheme(m.theme);
  else if (m.type === 'lang') setLang(m.lang);
  else if (m.type === 'load') load(m.buffer);
  else if (m.type === 'save-request') save(true);
  else if (m.type === 'saved') onSaved();
  else if (m.type === 'save-error') inFlight = null; // the host shows what went wrong; the notebook stays dirty
});

// Links: the sandbox has no allow-popups / top-navigation, so a plain click would navigate this frame away.
// In-page anchors scroll (rendering the target cell first if it is still a placeholder); everything else is inert.
function scrollToAnchor(id) {
  const find = () => document.getElementById(id) ?? document.getElementsByName(id)[0];
  let target = find();
  if (!target) {
    const plain = id.replace(/-/g, ' ');
    const needle = new RegExp(`^#{1,6}\\s+${plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ -]')}\\s*#*\\s*$|(?:id|name)=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'm');
    const c = cells.find((x) => !x.done && x.data?.cell_type === 'markdown' && needle.test(str(x.data.source)));
    if (c) { renderNow(c); target = find(); }
  }
  target?.scrollIntoView({ block: 'start' });
}

function onLinkClick(e) {
  const a = e.composedPath().find((n) => n instanceof Element && n.tagName === 'A' && n.hasAttribute('href'));
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (href.startsWith('#') && href.length > 1) {
    let id = href.slice(1);
    try { id = decodeURIComponent(id); } catch { /* keep raw */ }
    scrollToAnchor(id);
  }
}
addEventListener('click', onLinkClick);
addEventListener('auxclick', onLinkClick);
root.addEventListener('click', onListClick);
addEventListener('keydown', onCommandKey);
// Ctrl/Cmd+S inside the frame never reaches the admin, and the browser would "save page": save unprompted.
addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's') return;
  e.preventDefault();
  e.stopPropagation();
  save(false);
}, true);
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => e.preventDefault());

post({ type: 'ready', protocol: 1 });
