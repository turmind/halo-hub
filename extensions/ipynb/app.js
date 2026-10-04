import { ansiToFragment } from './ansi.js';
import { renderMarkdown, renderLatex, renderHtmlOutput, sanitizeSvg, highlight } from './markdown.js';

const post = (m) => parent.postMessage({ haloExt: 1, ...m }, '*');
const root = document.getElementById('root');

// ---- small helpers ---------------------------------------------------------------------------------------------------

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
// nbformat allows a string or a list of strings for text-like fields.
const str = (v) => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : v == null ? '' : String(v));
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
    btn.textContent = open ? 'Collapse' : `Show all · ${lines.toLocaleString()} lines · ${fmtBytes(text.length)}`;
  };
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
  if (sizeMeta?.width) img.setAttribute('width', String(sizeMeta.width));
  if (sizeMeta?.height) img.setAttribute('height', String(sizeMeta.height));
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

// ---- cells -----------------------------------------------------------------------------------------------------------

let notebookLang = 'python';

function cellLanguage(src) {
  const magic = /^%%(\w+)/.exec(src)?.[1]?.toLowerCase();
  if (magic === 'html') return 'xml';
  if (magic && highlight('', magic) !== null) return magic;
  return notebookLang;
}

function renderCell(cell) {
  const frag = document.createDocumentFragment();
  const src = str(cell.source);
  if (cell.cell_type === 'markdown') {
    const row = el('div', 'row');
    const body = el('div', 'body');
    body.append(renderMarkdown(src, cell.attachments));
    row.append(el('div', 'prompt'), body);
    frag.append(row);
  } else if (cell.cell_type === 'code') {
    const row = el('div', 'row inrow');
    const prompt = el('div', 'prompt in', `In [${cell.execution_count ?? ' '}]:`);
    const body = el('div', 'body');
    const pre = el('pre', 'src');
    const code = el('code', 'hljs');
    const html = highlight(src, cellLanguage(src));
    if (html != null) code.innerHTML = html; else code.textContent = src;
    pre.append(code);
    body.append(pre);
    row.append(prompt, body);
    frag.append(row, renderOutputs(cell));
  } else {
    const row = el('div', 'row');
    const body = el('div', 'body');
    body.append(el('pre', 'raw', src));
    row.append(el('div', 'prompt', 'Raw'), body);
    frag.append(row);
  }
  return frag;
}

// Rough height of a not-yet-rendered cell, so the scrollbar and jump positions are plausible before content exists.
function estimateHeight(cell) {
  const src = str(cell.source);
  const lines = src.split('\n').length;
  if (cell.cell_type === 'markdown') return 24 + Math.min(lines, 60) * 22;
  let h = 24 + Math.min(lines, 80) * 19;
  for (const o of cell.outputs ?? []) h += o?.data?.['image/png'] || o?.data?.['image/jpeg'] || o?.data?.['image/svg+xml'] ? 300 : 40;
  return h;
}

// ---- notebook --------------------------------------------------------------------------------------------------------

let cells = [];            // [{ data, el, done }]
let observer = null;
let idleHandle = null;
let fillPos = 0;
let lastText = null;
let bar = null;            // sticky header

const idle = window.requestIdleCallback ?? ((cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 30));
const cancelIdle = window.cancelIdleCallback ?? clearTimeout;

function renderNow(c) {
  if (c.done) return;
  c.done = true;
  observer?.unobserve(c.el);
  // A cell wholly above the viewport changes height when it goes from placeholder to content, which would shove what
  // the reader is looking at: measure, render, and scroll by the difference (native scroll anchoring is off, see style.css).
  const r = c.el.getBoundingClientRect();
  const above = r.bottom <= (bar?.offsetHeight ?? 0);
  c.el.style.minHeight = '';
  try {
    c.el.replaceChildren(renderCell(c.data));
  } catch (err) {
    c.el.replaceChildren(el('div', 'note', `[could not render this cell: ${err instanceof Error ? err.message : String(err)}]`));
  }
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
  observer?.disconnect();
  observer = null;
  if (idleHandle != null) cancelIdle(idleHandle);
  idleHandle = null;
  cells = [];
  fillPos = 0;
}

function captureAnchor() {
  const top = bar?.offsetHeight ?? 0;
  for (let i = 0; i < cells.length; i++) {
    const r = cells[i].el.getBoundingClientRect();
    if (r.bottom > top + 1) return { i, id: cells[i].data.id, off: top - r.top };
  }
  return null;
}

function kernelLabel(nb) {
  const ks = nb.metadata?.kernelspec;
  const li = nb.metadata?.language_info;
  const lang = li?.name ? `${li.name}${li.version ? ' ' + li.version : ''}` : ks?.language;
  const kernel = ks?.display_name || ks?.name;
  return [kernel, lang && lang !== kernel ? lang : null].filter(Boolean).join(' · ') || 'Unknown kernel';
}

function show(nb, anchor) {
  teardown();
  notebookLang = (nb.metadata?.kernelspec?.language || nb.metadata?.language_info?.name || 'python').toLowerCase();
  if (notebookLang === 'ir') notebookLang = 'r';

  const counts = { code: 0, markdown: 0, raw: 0 };
  const list = el('main', 'nb');
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) renderNow(e.target.__cell);
  }, { rootMargin: '1500px 0px' });

  for (const data of nb.cells) {
    const kind = data?.cell_type === 'code' || data?.cell_type === 'markdown' ? data.cell_type : 'raw';
    counts[kind]++;
    const shell = el('section', `cell ${kind}`);
    const c = { data: data ?? {}, el: shell, done: false };
    shell.__cell = c;
    shell.style.minHeight = `${estimateHeight(c.data)}px`;
    cells.push(c);
    list.append(shell);
  }

  bar = el('header', 'bar');
  const total = nb.cells.length;
  const parts = [`${total} cell${total === 1 ? '' : 's'}`];
  if (total) parts.push(`${counts.code} code · ${counts.markdown} markdown${counts.raw ? ` · ${counts.raw} raw` : ''}`);
  bar.append(el('span', 'kernel', kernelLabel(nb)), el('span', 'count', parts.join(' — ')));
  root.replaceChildren(bar, list);
  if (!total) list.append(el('div', 'empty', 'This notebook has no cells.'));

  // Render what is around the previous scroll position first, then observe everything else.
  if (anchor) {
    // nbformat 4.5 cells carry an id: follow the cell even when cells were inserted or removed above it.
    const byId = anchor.id != null ? cells.findIndex((c) => c.data.id === anchor.id) : -1;
    const i = Math.min(byId >= 0 ? byId : anchor.i, cells.length - 1);
    for (let k = Math.max(0, i - 2); k <= Math.min(cells.length - 1, i + 6); k++) renderNow(cells[k]);
    window.scrollTo(0, Math.max(0, cells[i].el.offsetTop + anchor.off - (bar.offsetHeight)));
  }
  for (const c of cells) if (!c.done) observer.observe(c.el);
  if (cells.length) fillRest();
}

function fail(message) {
  teardown();
  lastText = null;
  const box = el('div', 'fail');
  box.append(el('strong', null, 'Cannot display this notebook'), el('p', null, message));
  root.replaceChildren(box);
  post({ type: 'error', message });
}

function problemWith(nb) {
  if (nb === null || typeof nb !== 'object' || Array.isArray(nb)) return 'Not a Jupyter notebook: the top-level JSON value is not an object.';
  if (nb.worksheets || (typeof nb.nbformat === 'number' && nb.nbformat < 4)) {
    return `This is an nbformat ${nb.nbformat ?? 3} notebook; only nbformat 4 is supported. Upgrade it with "jupyter nbconvert --to notebook --inplace <file>".`;
  }
  if (!Array.isArray(nb.cells)) return 'Not a Jupyter notebook: there is no "cells" list.';
  return null;
}

function load(buffer) {
  const text = new TextDecoder().decode(buffer);
  if (text === lastText) return; // identical bytes: keep scroll position and expanded outputs
  if (!text.trim()) return fail('The file is empty, so there is no notebook to show.');
  let nb;
  try { nb = JSON.parse(text); } catch (err) { return fail(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`); }
  const problem = problemWith(nb);
  if (problem) return fail(problem);
  const anchor = lastText != null ? captureAnchor() : null;
  lastText = text;
  show(nb, anchor);
}

// ---- host wiring -----------------------------------------------------------------------------------------------------

const setTheme = (t) => { document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark'; };
setTheme('dark'); // the admin's default until init says otherwise

addEventListener('message', (e) => {
  if (e.source !== parent || e.data?.haloExt !== 1) return;
  const m = e.data;
  if (m.type === 'init' || m.type === 'theme') setTheme(m.theme);
  else if (m.type === 'load') load(m.buffer);
});

// Links: the sandbox has no allow-popups / top-navigation, so a plain click would navigate this frame away.
// In-page anchors scroll (rendering the target cell first if it is still a placeholder); everything else is inert.
function scrollToAnchor(id) {
  const find = () => document.getElementById(id) ?? document.getElementsByName(id)[0];
  let target = find();
  if (!target) {
    const plain = id.replace(/-/g, ' ');
    const needle = new RegExp(`^#{1,6}\\s+${plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ -]')}\\s*#*\\s*$|(?:id|name)=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'm');
    const c = cells.find((x) => !x.done && x.data.cell_type === 'markdown' && needle.test(str(x.data.source)));
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
// Read-only viewer: swallow the browser's "save page" on Ctrl/Cmd+S and files dropped onto the frame.
addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') e.preventDefault(); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => e.preventDefault());

post({ type: 'ready', protocol: 1 });
