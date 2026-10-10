// Notebook model helpers with no DOM, so they can run (and be tested) in Node too: parse with number source text
// kept, serialize the way Jupyter writes, Python-style line splitting, kernel messages → nbformat outputs.

/** nbformat allows a string or a list of strings for text-like fields. */
export const str = (v) => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * JSON.parse that keeps the source text of numbers JS would print differently (1.0, 1e-05, -0, integers beyond
 * 2^53), so an untouched notebook serializes back byte-identical. Needs JSON.parse source text access (Chrome 114+);
 * without it those numbers come back in JS form.
 */
export function parseNotebook(text) {
  if (typeof JSON.rawJSON !== 'function') return JSON.parse(text);
  return JSON.parse(text, (k, v, ctx) => (typeof v === 'number' && ctx?.source != null && String(v) !== ctx.source ? JSON.rawJSON(ctx.source) : v));
}

/** A number from the notebook as a JS number (parseNotebook may hand back a raw-JSON wrapper, see above). */
export const num = (v) => (typeof JSON.isRawJSON === 'function' && JSON.isRawJSON(v) ? Number(v.rawJSON) : v);

/**
 * Jupyter's writer: json.dumps(indent=1, ensure_ascii=False, sort_keys=True) + "\n". Key order is the parsed
 * order (a Jupyter-written file is already sorted); objects this extension creates are built sorted.
 * (JS objects put integer-like keys first, so a Python-sorted {"10", "2"} would come back as {"2", "10"}.)
 */
export const serializeNotebook = (nb) => JSON.stringify(nb, null, 1) + '\n';

// Python str.splitlines(keepends=True): the line boundaries nbformat splits on when it writes a notebook.
const LINE_END = /\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]/g;
export function splitLines(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(LINE_END)) {
    out.push(text.slice(last, m.index + m[0].length));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isSorted = (keys) => keys.every((k, i) => i === 0 || keys[i - 1] <= k);

/** Set obj[key] in place; a key that is new goes in sorted position when obj's keys are sorted (else at the end). */
export function setKey(obj, key, value) {
  if (Object.hasOwn(obj, key) || !isSorted(Object.keys(obj))) { obj[key] = value; return; }
  const entries = Object.entries(obj);
  for (const [k] of entries) delete obj[k];
  for (const [k, v] of [...entries, [key, value]].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) obj[k] = v;
}

/** Deep copy with every object's keys sorted — for content from the kernel, which Jupyter writes sorted. */
export function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}

// nbformat's split_lines: text/* and these mime values are stored as lists of lines.
const SPLIT_MIMES = new Set(['application/javascript', 'image/svg+xml']);
function bundle(data) {
  const o = {};
  for (const k of Object.keys(data ?? {}).sort()) {
    const v = data[k];
    o[k] = typeof v === 'string' && (k.startsWith('text/') || SPLIT_MIMES.has(k)) ? splitLines(v) : sortKeys(v);
  }
  return o;
}

/** An iopub message's content as the nbformat output Jupyter would store (keys sorted, text split into lines). */
export function outputFrom(msgType, c) {
  switch (msgType) {
    case 'stream': return { name: c.name, output_type: 'stream', text: splitLines(str(c.text)) };
    case 'display_data': return { data: bundle(c.data), metadata: sortKeys(c.metadata ?? {}), output_type: 'display_data' };
    case 'execute_result': return { data: bundle(c.data), execution_count: c.execution_count ?? null, metadata: sortKeys(c.metadata ?? {}), output_type: 'execute_result' };
    case 'error': return { ename: c.ename, evalue: c.evalue, output_type: 'error', traceback: c.traceback ?? [] };
    default: return null;
  }
}

/** The data / metadata of an update_display_data, in stored form. */
export const displayUpdate = (c) => ({ data: bundle(c.data), metadata: sortKeys(c.metadata ?? {}) });

/** Append streamed text to a stored stream output (re-splitting its last line, which may not have ended). */
export function appendStream(out, text) {
  const lines = Array.isArray(out.text) ? out.text : splitLines(str(out.text));
  const tail = lines.pop() ?? '';
  for (const l of splitLines(tail + text)) lines.push(l);
  out.text = lines;
}

/** A new cell as Jupyter creates it; `id` only for nbformat ≥ 4.5. */
export function newCell(type, id) {
  const c = type === 'code'
    ? { cell_type: 'code', execution_count: null, id, metadata: {}, outputs: [], source: [] }
    : { cell_type: type, id, metadata: {}, source: [] };
  if (id == null) delete c.id;
  return c;
}

/** Switch a cell's type in place: a code cell has outputs + execution_count, markdown / raw may have attachments. */
export function convertCell(cell, type) {
  cell.cell_type = type;
  if (type === 'code') {
    delete cell.attachments;
    setKey(cell, 'execution_count', cell.execution_count ?? null);
    setKey(cell, 'outputs', Array.isArray(cell.outputs) ? cell.outputs : []);
  } else {
    delete cell.outputs;
    delete cell.execution_count;
  }
}

export const wantsIds = (nb) => num(nb.nbformat) > 4 || (num(nb.nbformat) === 4 && num(nb.nbformat_minor) >= 5);
