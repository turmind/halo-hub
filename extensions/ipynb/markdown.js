// Markdown / LaTeX -> sanitized DOM. Notebook content is untrusted, so the pipeline is:
//   extract math -> marked -> DOMPurify -> DOM post-processing (KaTeX, highlight, images, ids)
// KaTeX output is inserted *after* sanitizing, and only as DOM nodes at text positions — never spliced into the HTML
// string — so math can't break out of an attribute.

const { marked, DOMPurify, hljs, katex } = window;

const md = new marked.Marked({ gfm: true, breaks: false });

// Attribute hygiene shared by every sanitized fragment: links never open anything (the sandbox has no popups), and
// `attachment:` image sources (notebook cell attachments) survive sanitizing so they can be resolved afterwards.
// Output CSS must not fetch anything: the page's CSP is the enforcement (img-src / style-src / font-src have no network
// origins); this scrub only keeps the attempts from being made at all (and from showing up as console errors).
const CSS_FETCH = /@import[^;]*;?|url\(\s*(?!["']?data:image\/)[^)]*\)/gi;
const scrubCss = (css) => css.replace(CSS_FETCH, (m) => (m[0] === '@' ? '' : 'none'));
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  const tag = node.nodeName.toLowerCase();
  if (data.attrName === 'src' && tag === 'img' && /^attachment:/i.test(data.attrValue)) data.forceKeepAttr = true;
  if (data.attrName === 'style') data.attrValue = scrubCss(data.attrValue);
  // SVG references: same-document "#id" (matplotlib markers use <use>) or an embedded raster, never a URL.
  if ((data.attrName === 'href' || data.attrName === 'xlink:href') && (tag === 'use' || tag === 'image' || tag === 'feimage')) {
    data.keepAttr = data.forceKeepAttr = /^#[\w.:-]+$/.test(data.attrValue) || /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(data.attrValue);
  }
});
DOMPurify.addHook('uponSanitizeElement', (node) => {
  if (node.nodeName === 'STYLE' && node.textContent) node.textContent = scrubCss(node.textContent);
});
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'A') { node.removeAttribute('target'); node.setAttribute('rel', 'noopener noreferrer'); }
});

const MD_CONFIG = { FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'button'], FORBID_ATTR: ['srcset'] };
// FORCE_BODY keeps a leading <style> (pandas Styler); the result is rendered inside a shadow root, so it stays scoped.
const HTML_CONFIG = { FORCE_BODY: true, FORBID_TAGS: ['form', 'input', 'textarea', 'select', 'button'], FORBID_ATTR: ['srcset'] };
// <use> is what matplotlib draws scatter markers with; the hook above pins it to same-document "#id" references.
const SVG_CONFIG = { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['style', 'use'] };

// DOMPurify drops <base> anyway, but its inert parse document inherits the page CSP (`base-uri 'none'`) and logs a
// violation per tag; removing them up front keeps the console clean.
const dropBase = (html) => html.replace(/<base\b[^>]*>/gi, '');
export const sanitizeHtml = (html) => DOMPurify.sanitize(dropBase(html), HTML_CONFIG);
export const sanitizeSvg = (svg) => DOMPurify.sanitize(dropBase(svg), SVG_CONFIG);

// ---- math extraction -------------------------------------------------------------------------------------------------

// Placeholders are private-use characters so neither marked nor the sanitizer can mistake them for markup or text.
const PH = /\uE000(\d+)\uE001/g;
// Environments that are display math on their own (the others, aligned / cases / matrix…, only exist inside $…$).
const MATH_ENVS = new Set(['equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'flalign', 'flalign*']);
// KaTeX lacks these environments; the closest supported ones give the same layout for notebook-style use.
const ENV_ALIAS = { eqnarray: 'align', 'eqnarray*': 'align*', multline: 'gather', 'multline*': 'gather*', flalign: 'align', 'flalign*': 'align*' };

/** Pull $…$ / $$…$$ / \(…\) / \[…\] / \begin{env}…\end{env} out of `src` (skipping code) and leave placeholders. */
export function extractMath(src) {
  src = src.replace(/[\uE000\uE001]/g, '');
  const maths = [];
  let out = '';
  const n = src.length;
  const put = (tex, display) => { out += `\uE000${maths.length}\uE001`; maths.push({ tex, display, raw: '' }); return maths[maths.length - 1]; };
  for (let i = 0; i < n;) {
    const ch = src[i];
    const lineStart = i === 0 || src[i - 1] === '\n';
    if ((ch === '`' || ch === '~') && lineStart && src.startsWith(ch.repeat(3), i)) {
      // fenced code block: copy through the closing fence
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(src.slice(i, i + 40));
      const fence = m ? m[1] : ch.repeat(3);
      const close = src.indexOf('\n' + fence, src.indexOf('\n', i) + 1 || n);
      const end = close < 0 ? n : src.indexOf('\n', close + 1) < 0 ? n : src.indexOf('\n', close + 1);
      out += src.slice(i, end); i = end; continue;
    }
    if (ch === '`') {
      let k = i; while (src[k] === '`') k++;
      const run = src.slice(i, k);
      const close = src.indexOf(run, k);
      if (close >= 0) { out += src.slice(i, close + run.length); i = close + run.length; } else { out += run; i = k; }
      continue;
    }
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === '[' || next === '(') {
        const close = src.indexOf(next === '[' ? '\\]' : '\\)', i + 2);
        if (close >= 0) { const m = put(src.slice(i + 2, close), next === '['); m.raw = src.slice(i, close + 2); i = close + 2; continue; }
      } else if (src.startsWith('\\begin{', i)) {
        const nameEnd = src.indexOf('}', i + 7);
        const name = nameEnd > 0 ? src.slice(i + 7, nameEnd) : '';
        if (MATH_ENVS.has(name)) {
          const endTag = `\\end{${name}}`;
          const close = src.indexOf(endTag, nameEnd);
          if (close >= 0) {
            const alias = ENV_ALIAS[name] ?? name;
            const body = src.slice(nameEnd + 1, close);
            const m = put(`\\begin{${alias}}${body}\\end{${alias}}`, true);
            m.raw = src.slice(i, close + endTag.length); i = close + endTag.length; continue;
          }
        }
      }
      out += src.slice(i, i + 2); i += 2; continue; // keeps `\$` literal
    }
    if (ch === '$') {
      if (src[i + 1] === '$') {
        const close = src.indexOf('$$', i + 2);
        if (close >= 0) { const m = put(src.slice(i + 2, close), true); m.raw = src.slice(i, close + 2); i = close + 2; continue; }
        out += '$$'; i += 2; continue;
      }
      const first = src[i + 1];
      if (first !== undefined && !/\s/.test(first)) {
        let j = i + 1, close = -1;
        while (j < n) {
          const c = src[j];
          if (c === '\\') { j += 2; continue; }
          if (c === '\n' && /^\n\s*\n/.test(src.slice(j, j + 40))) break; // never span a paragraph break
          if (c === '$') { if (!/\s/.test(src[j - 1]) && !/\d/.test(src[j + 1] ?? '')) close = j; break; }
          j++;
        }
        if (close >= 0) { const m = put(src.slice(i + 1, close), false); m.raw = src.slice(i, close + 1); i = close + 1; continue; }
      }
    }
    out += ch; i++;
  }
  return { text: out, maths };
}

function renderKatex(m) {
  const t = document.createElement('template');
  t.innerHTML = katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false, strict: 'ignore', maxSize: 50, maxExpand: 1000 });
  return t.content;
}

/** Replace math placeholders in the text nodes under `root` (raw source inside code, KaTeX elsewhere). */
export function fillMath(root, maths) {
  if (!maths.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let nd = walker.nextNode(); nd; nd = walker.nextNode()) if (nd.nodeValue.includes('\uE000')) nodes.push(nd);
  for (const nd of nodes) {
    const inCode = nd.parentElement?.closest('code, pre');
    const parts = nd.nodeValue.split(PH); // [text, idx, text, idx, ...]
    const frag = document.createDocumentFragment();
    parts.forEach((p, k) => {
      if (k % 2 === 0) { if (p) frag.append(p); return; }
      const m = maths[Number(p)];
      if (!m) return;
      if (inCode) frag.append(m.raw || `$${m.tex}$`); else frag.append(renderKatex(m));
    });
    nd.replaceWith(frag);
  }
}

// ---- code highlighting -----------------------------------------------------------------------------------------------

const MAX_HIGHLIGHT = 100_000;
/** highlight.js HTML (already escaped) or null when the language is unknown / the source is huge. */
export function highlight(code, lang) {
  if (!lang || code.length > MAX_HIGHLIGHT || !hljs.getLanguage(lang)) return null;
  try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { return null; }
}

// ---- public renderers ------------------------------------------------------------------------------------------------

function blockImage(img, attachments) {
  const src = img.getAttribute('src') ?? '';
  if (/^attachment:/i.test(src)) {
    const files = attachments?.[decodeURIComponent(src.slice(11))];
    const mime = files && Object.keys(files).find((k) => k.startsWith('image/'));
    if (mime) { img.setAttribute('src', `data:${mime};base64,${String(files[mime]).replace(/\s+/g, '')}`); return; }
  } else if (/^data:image\//i.test(src)) return;
  // Remote (or unresolvable) image: the viewer is offline and never makes requests, so leave a labelled placeholder.
  const ph = document.createElement('span');
  ph.className = 'img-blocked';
  ph.textContent = `[image: ${img.getAttribute('alt') || src.slice(0, 80)}]`;
  ph.title = src;
  img.replaceWith(ph);
}

/** Markdown source -> a `div.md` element. */
export function renderMarkdown(src, attachments) {
  const { text, maths } = extractMath(src);
  const clean = DOMPurify.sanitize(dropBase(md.parse(text, { async: false })), MD_CONFIG);
  const box = document.createElement('div');
  box.className = 'md';
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  const root = tpl.content;
  for (const img of root.querySelectorAll('img')) blockImage(img, attachments);
  // Jupyter heading ids: the heading text with spaces turned into dashes, so `[x](#My-Heading)` links work.
  for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) if (!h.id) h.id = h.textContent.trim().replace(/\s+/g, '-');
  for (const code of root.querySelectorAll('pre > code[class*="language-"]')) {
    const lang = /language-([\w+-]+)/.exec(code.className)?.[1];
    const html = highlight(code.textContent, lang);
    if (html != null) { code.innerHTML = html; code.classList.add('hljs'); }
  }
  for (const a of root.querySelectorAll('a[href]')) if (!a.title) a.title = a.getAttribute('href');
  fillMath(root, maths);
  box.append(root);
  return box;
}

/** text/latex output: math delimiters are typeset, anything else stays text. */
export function renderLatex(src) {
  const { text, maths } = extractMath(src);
  const box = document.createElement('div');
  box.className = 'out-latex';
  box.textContent = text;
  fillMath(box, maths);
  return box;
}

const HTML_BASE = `
:host{display:block;contain:paint;overflow:auto;max-height:520px;color:var(--fg);font:14px/1.45 system-ui,sans-serif}
:host(.paper){background:#fff;color:#1f2328;padding:4px 6px;border-radius:4px}
*{box-sizing:border-box}
img,svg,canvas{max-width:100%}
table{border-collapse:collapse;border:none;font-size:13px;table-layout:auto}
th,td{padding:4px 10px;border:none;vertical-align:middle}
thead tr{border-bottom:1px solid var(--border-strong)}
thead th{text-align:right;font-weight:600}
tbody th{font-weight:600}
td{text-align:right}
tbody tr:nth-child(odd){background:var(--row-alt)}
:host(.paper) tbody tr:nth-child(odd){background:rgba(0,0,0,.04)}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
a{color:var(--link)}
:host(.paper) a{color:#0969da}
`;

const PAPER_HINT = /background(-color)?\s*:|bgcolor\s*=/i;

/** text/html output -> a shadow-scoped host (styles inside the output can't leak into, or out of, the notebook). */
export function renderHtmlOutput(html) {
  const clean = sanitizeHtml(html);
  const host = document.createElement('div');
  host.className = 'out-html';
  if (PAPER_HINT.test(clean)) host.classList.add('paper'); // explicit cell colors (pandas Styler) assume a light page
  const shadow = host.attachShadow({ mode: 'open' });
  const base = document.createElement('style');
  base.textContent = HTML_BASE;
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  for (const img of tpl.content.querySelectorAll('img')) blockImage(img, null);
  for (const a of tpl.content.querySelectorAll('a[href]')) if (!a.title) a.title = a.getAttribute('href');
  // Script-only output (plotly, bokeh…) sanitizes to nothing: let the caller fall back to another representation.
  if (!tpl.content.textContent.trim() && !tpl.content.querySelector('img, svg, canvas, table, video, audio, hr, .img-blocked')) return null;
  shadow.append(base, tpl.content);
  return host;
}
