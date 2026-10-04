// ANSI escape sequences (Jupyter tracebacks / colored stream output) -> DOM nodes. Built with createElement /
// textContent only, so the text can never turn into markup. Unknown escapes are dropped.

// SGR (colors), other CSI, OSC, 2-char escapes, and stray C0 controls (\t \n \r are kept).
const ESC = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][A-Za-z0-9]|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

const CUBE = [0, 95, 135, 175, 215, 255];
function color256(n) {
  if (n < 16) return n; // palette index -> CSS class (theme-aware)
  if (n < 232) { const i = n - 16; return `rgb(${CUBE[(i / 36) | 0]},${CUBE[((i / 6) | 0) % 6]},${CUBE[i % 6]})`; }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

function applySgr(st, params) {
  const p = params === '' ? [0] : params.replace(/:/g, ';').split(';').map((s) => (s === '' ? 0 : parseInt(s, 10)));
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0) { st.fg = st.bg = null; st.bold = st.dim = st.italic = st.underline = st.inverse = false; }
    else if (n === 1) st.bold = true;
    else if (n === 2) st.dim = true;
    else if (n === 3) st.italic = true;
    else if (n === 4) st.underline = true;
    else if (n === 7) st.inverse = true;
    else if (n === 22) st.bold = st.dim = false;
    else if (n === 23) st.italic = false;
    else if (n === 24) st.underline = false;
    else if (n === 27) st.inverse = false;
    else if (n >= 30 && n <= 37) st.fg = n - 30;
    else if (n >= 90 && n <= 97) st.fg = n - 82;
    else if (n >= 40 && n <= 47) st.bg = n - 40;
    else if (n >= 100 && n <= 107) st.bg = n - 92;
    else if (n === 39) st.fg = null;
    else if (n === 49) st.bg = null;
    else if (n === 38 || n === 48) {
      const key = n === 38 ? 'fg' : 'bg';
      if (p[i + 1] === 5) { st[key] = color256(p[i + 2] ?? 0); i += 2; }
      else if (p[i + 1] === 2) { st[key] = `rgb(${p[i + 2] ?? 0},${p[i + 3] ?? 0},${p[i + 4] ?? 0})`; i += 4; }
    }
  }
}

const isPlain = (st) => st.fg == null && st.bg == null && !st.bold && !st.dim && !st.italic && !st.underline && !st.inverse;

function styled(text, st) {
  if (isPlain(st)) return document.createTextNode(text);
  const span = document.createElement('span');
  span.textContent = text;
  let { fg, bg } = st;
  if (st.inverse) { const t = fg; fg = bg ?? 'inv-bg'; bg = t ?? 'inv-fg'; }
  if (typeof fg === 'number') span.classList.add(`af${fg}`); else if (fg === 'inv-bg') span.classList.add('a-inv-bg'); else if (fg) span.style.color = fg;
  if (typeof bg === 'number') span.classList.add(`ab${bg}`); else if (bg === 'inv-fg') span.classList.add('a-inv-fg'); else if (bg) span.style.backgroundColor = bg;
  if (st.bold) span.classList.add('a-b');
  if (st.dim) span.classList.add('a-d');
  if (st.italic) span.classList.add('a-i');
  if (st.underline) span.classList.add('a-u');
  return span;
}

/** Progress bars rewrite the line with "\r": keep what the terminal would end up showing (the last non-empty write). */
function resolveCarriageReturns(text) {
  text = text.replace(/\r\n/g, '\n');
  if (!text.includes('\r')) return text;
  return text.split('\n').map((line) => {
    if (!line.includes('\r')) return line;
    const segs = line.split('\r').filter((s) => s !== '');
    return segs.length ? segs[segs.length - 1] : '';
  }).join('\n');
}

export function ansiToFragment(text) {
  const frag = document.createDocumentFragment();
  const st = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };
  text = resolveCarriageReturns(text);
  let last = 0;
  ESC.lastIndex = 0;
  for (let m = ESC.exec(text); m; m = ESC.exec(text)) {
    if (m.index > last) frag.append(styled(text.slice(last, m.index), st));
    if (m[1] !== undefined) applySgr(st, m[1]);
    last = ESC.lastIndex;
  }
  if (last < text.length) frag.append(styled(text.slice(last), st));
  return frag;
}
