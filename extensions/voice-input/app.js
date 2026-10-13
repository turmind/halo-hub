// Voice Input — see README.md. Mic -> AudioWorklet (pcm-worklet.js, 16 kHz mono s16le) -> the Halo server's on-device
// speech-to-text WebSocket (/api/stt/stream). Every `final` is inserted at the chat-box caret with `insert-text`.
// The protocol has no frame that sends a message: the user always presses Send.
// One click: the host mounts this panel from the toolbar button and recording starts on `init`. While a recording has
// audio in flight we report `busy`, so closing the panel (toolbar button again, ×, Esc) arrives as `close-request`:
// stop, let the last sentences land in the draft, then `busy:false` and the host unmounts us.

const post = (m) => parent.postMessage({ haloExt: 1, ...m }, '*');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const LS = 'halo-ext-voice-input:'; // the iframe shares the admin's origin, so its localStorage too
/** After `end`, how long to wait for the server's last finals + close 1000 before giving up. */
const FINISH_TIMEOUT_MS = 30000; // < the host's 35 s close-request deadline
/** How long a suspended AudioContext gets to resume before we fall back to a "click to start" button. */
const RESUME_WAIT_MS = 1000;
/** A segment ending in a Han / kana character or CJK / full-width punctuation joins the next one without a space.
 *  Hangul is left out on purpose: Korean separates words with spaces, so it gets the joiner space like English. */
const CJK_END = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u{20000}-\u{3ffff}]$/u;

const URLS = {
  sensevoice: 'https://github.com/FunAudioLLM/SenseVoice',
  sherpaModel: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
  license: 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE',
  silero: 'https://github.com/snakers4/silero-vad',
  sherpa: 'https://github.com/k2-fsa/sherpa-onnx',
};

// ---- i18n ------------------------------------------------------------------------------------------------------------

const T = {
  en: {
    stop: 'Stop', resume: 'Resume', retry: 'Retry', startRec: 'Start recording',
    stopped: 'Stopped',
    needClick: 'The browser needs a click before it can record.',
    starting: 'Opening the microphone…', connecting: 'Connecting to the speech service…',
    preparing: 'First use: preparing the speech model download (about 240 MB)…',
    downloading: (p) => `First use: downloading the speech model ${p}% (about 240 MB)`,
    waitHint: 'Recording starts by itself once it’s ready; anything said before that isn’t recognized.',
    loadingEngine: 'Loading the speech engine…', listening: 'Listening…',
    listenHint: 'Click the toolbar mic again to stop. You send the text yourself.',
    finishing: 'Recognizing…',
    errModel: 'The speech model failed to download. It will retry the next time you open this.',
    errEngine: (m) => `The on-device speech engine is unavailable: ${m}`,
    errBusy: 'The server is busy. Try again in a moment.',
    errOther: (m) => `Speech recognition failed: ${m}`,
    unreachable: 'Cannot reach the speech service (logged out, or Halo is older than 1.6.5).',
    dropped: 'The connection to the server was lost.',
    noMedia: 'Voice input needs a secure page: open Halo over HTTPS (or on localhost), or use the Halo desktop app.',
    micDenied: 'Microphone access was denied. Allow it in the browser’s site settings (or the system’s privacy settings) and try again.',
    noMic: 'No microphone found.',
    micFailed: (m) => `Cannot open the microphone: ${m}`,
    micDefault: 'Default microphone', micN: 'Microphone',
    about: 'About', aboutTitle: 'About Voice Input', back: 'Back',
    aboutRows: [
      ['Model', 'SenseVoice-Small (FunAudioLLM / Alibaba Tongyi Lab), int8 ONNX, run with sherpa-onnx.', [['Source', URLS.sensevoice], ['sherpa-onnx conversion', URLS.sherpaModel]]],
      ['License', 'FunASR Model License v1.1', [['', URLS.license]], true],
      ['VAD', 'Silero VAD (MIT)', [['', URLS.silero]]],
      ['Runtime', 'sherpa-onnx (Apache-2.0)', [['', URLS.sherpa]]],
    ],
    aboutNote: 'Your Halo server downloads the model from Hugging Face / ModelScope; halo-hub does not distribute the weights. Audio never leaves your own Halo server.',
    viewLicense: 'View the license text', loading: 'Loading…', loadFailed: (m) => `Cannot load the license text: ${m}`,
  },
  zh: {
    stop: '停止', resume: '继续', retry: '重试', startRec: '开始录音',
    stopped: '已停止',
    needClick: '浏览器要求先点一下才能录音',
    starting: '正在打开麦克风…', connecting: '正在连接语音服务…',
    preparing: '首次使用，正在准备下载语音模型（约 240MB）…',
    downloading: (p) => `首次使用，正在下载语音模型 ${p}%（约 240MB）`,
    waitHint: '就绪后自动开始录音，在此之前说的话不会被识别',
    loadingEngine: '正在加载语音引擎…', listening: '正在听…',
    listenHint: '再点一下工具栏的麦克风停止，文字由你自己发送',
    finishing: '正在识别…',
    errModel: '语音模型下载失败，下次打开会重试',
    errEngine: (m) => `本机语音引擎不可用：${m}`,
    errBusy: '服务器繁忙，请稍后再试',
    errOther: (m) => `语音识别出错：${m}`,
    unreachable: '无法连接语音服务（未登录，或 Halo 版本低于 1.6.5）',
    dropped: '与服务器的连接已断开',
    noMedia: '语音输入需要安全连接：请通过 HTTPS（或 localhost）打开 Halo，或使用 Halo 桌面版',
    micDenied: '麦克风权限被拒绝，请到浏览器的网站设置（或系统的隐私设置）里允许后重试',
    noMic: '没有找到麦克风',
    micFailed: (m) => `无法打开麦克风：${m}`,
    micDefault: '默认麦克风', micN: '麦克风',
    about: '关于', aboutTitle: '关于语音输入', back: '返回',
    aboutRows: [
      ['模型', 'SenseVoice-Small（FunAudioLLM / 阿里巴巴通义实验室），int8 ONNX，经 sherpa-onnx 运行。', [['来源', URLS.sensevoice], ['sherpa 转换版', URLS.sherpaModel]]],
      ['许可', 'FunASR Model License v1.1', [['', URLS.license]], true],
      ['VAD', 'Silero VAD（MIT）', [['', URLS.silero]]],
      ['运行时', 'sherpa-onnx（Apache-2.0）', [['', URLS.sherpa]]],
    ],
    aboutNote: '模型由你的 Halo 服务器从 Hugging Face / ModelScope 下载，hub 不分发模型权重；音频不出你自己的 Halo 服务器。',
    viewLicense: '查看协议原文', loading: '加载中…', loadFailed: (m) => `无法加载协议原文：${m}`,
  },
};
let lang = /^zh/i.test(navigator.language) ? 'zh' : 'en';
const t = (k, ...a) => { const v = T[lang][k] ?? T.en[k]; return typeof v === 'function' ? v(...a) : v; };

// ---- state -------------------------------------------------------------------------------------------------------------

/** idle | starting (getUserMedia + audio graph) | waiting (WS open, before `ready`) | recording | finishing (after `end`).
 *  Starts as `starting`: the chat-bar `init` that auto-starts the recording is on its way. */
let phase = 'starting';
/** The current recording: { stream, ctx, an, node, ws, opened, ready, startedAt, raf, err, closing, finishTimer, restart }. */
let rec = null;
/** Latest `model` frame while waiting; null = nothing heard yet. */
let model = null;
/** Why we're idle, as a thunk so a `lang` frame re-translates it: an error, or the autoplay fallback. Null = stopped. */
let notice = null;
/** Idle because the AudioContext stayed suspended (autoplay policy): offer a plain "start" button, not "retry". */
let needGesture = false;
/** Last segment inserted by this recording, for the joiner. Reset on every start: the caret may have moved since. */
let lastText = '';
const recent = [];
/** The host's `init` is re-sent on every `ready`; recording auto-starts once per iframe. */
let autoStarted = false;
/** The host asked to close (`close-request`): when back to idle, say `busy:false` and stay idle (no auto anything). */
let closing = false;
/** Last `busy` reported to the host; only changes are posted. */
let busySent = false;

/** `busy` = closing the panel now would lose audio already sent: true exactly while recording / finishing. */
function setPhase(next) {
  phase = next;
  const busy = phase === 'recording' || phase === 'finishing';
  if (busy !== busySent) { busySent = busy; post({ type: 'busy', busy }); }
  render();
}

function render() {
  const ind = $('ind');
  ind.dataset.phase = phase;
  let status = '', sub = '', act = '';
  const dl = phase === 'waiting' && (model?.state === 'downloading' || model?.state === 'missing');
  if (phase === 'idle') {
    if (needGesture) { status = t('needClick'); act = 'startRec'; }
    else if (notice) { status = notice(); act = 'retry'; }
    else { status = t('stopped'); act = 'resume'; }
  } else if (phase === 'starting') status = t('starting');
  else if (phase === 'waiting') {
    act = 'stop';
    if (!model) status = t('connecting');
    else if (model.state === 'downloading') {
      const p = model.total ? Math.min(100, Math.floor((model.received / model.total) * 100)) : 0;
      status = t('downloading', p);
      sub = t('waitHint');
      $('dl').style.width = `${p}%`;
    } else if (model.state === 'missing') { status = t('preparing'); sub = t('waitHint'); $('dl').style.width = '0%'; }
    else if (model.state === 'error') status = t('errModel'); // the `error` frame + close 1011 follow at once
    else status = t('loadingEngine');
  } else if (phase === 'recording') { status = t('listening'); sub = t('listenHint'); act = 'stop'; }
  else status = t('finishing');
  if (closing || (phase === 'idle' && !navigator.mediaDevices)) act = ''; // being unmounted / retry can't help
  ind.classList.toggle('err', phase === 'idle' && !!notice && !needGesture);
  $('status').textContent = status;
  $('status').classList.toggle('err', phase === 'idle' && !!notice && !needGesture);
  $('sub').textContent = sub;
  $('sub').hidden = !sub;
  $('dlRow').hidden = !dl;
  $('levelRow').hidden = phase !== 'recording';
  $('timer').hidden = phase !== 'recording';
  $('act').hidden = !act;
  if (act) { $('act').textContent = t(act); $('act').dataset.act = act; }
  // Device picker ("Default" + at least two devices): while idle, or to switch mid-recording (restarts on the new one).
  $('mic').hidden = closing || (phase !== 'idle' && phase !== 'recording') || $('mic').options.length < 3;
}

function renderRecent() {
  $('recent').replaceChildren(...recent.map((s) => { const n = el('div', 'line', s); n.title = s; return n; }));
}

// ---- recording -----------------------------------------------------------------------------------------------------------

function micError(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return () => t('micDenied');
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return () => t('noMic');
  return () => t('micFailed', e?.message || e?.name || String(e));
}

function sttError(m) {
  if (m.code === 'model') return () => t('errModel');
  if (m.code === 'engine') return () => t('errEngine', m.message || m.code);
  if (m.code === 'busy') return () => t('errBusy');
  return () => t('errOther', m.message || m.code);
}

/** Back to idle from any phase (`rec` already torn down). A pending close-request is answered by setPhase's busy:false;
 *  a device switch (`restart`) starts the next recording right away. */
function toIdle(why, restart = false) {
  rec = null; model = null; notice = why; needGesture = false;
  setPhase('idle');
  if (restart && !closing) start();
}

async function start() {
  if (rec || closing) return;
  if (!navigator.mediaDevices?.getUserMedia) { notice = () => t('noMedia'); setPhase('idle'); return; }
  notice = null; needGesture = false; model = null; lastText = '';
  setPhase('starting');
  const r = rec = {};
  try {
    // Created (and resumed) before any await, so on the fallback "start" click it is still inside the gesture.
    // Auto-started from `init`, the panel mounted right after the toolbar click and is same-origin, so it normally has
    // the page's user activation and runs. If an autoplay policy still holds it suspended (a risk on Safari / iOS),
    // resume() won't settle without a gesture: we fall back to a "start" button below, without reporting busy.
    const ctx = r.ctx = new AudioContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    // Before the first grant the list has no ids, so fall back to the remembered one; `ideal` = a device that's gone
    // falls back to the default instead of failing.
    const id = $('mic').value || localStorage.getItem(`${LS}mic`) || '';
    r.stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(id ? { deviceId: { ideal: id } } : {}), echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    teardown(r);
    if (rec === r) toIdle(micError(e));
    return;
  }
  if (rec !== r) { stopAudio(r); return; } // stopped meanwhile
  refreshDevices(); // labels are available now
  try {
    const ctx = r.ctx;
    if (ctx.state === 'suspended') await Promise.race([ctx.resume(), sleep(RESUME_WAIT_MS)]);
    if (rec !== r) { teardown(r); return; }
    if (ctx.state === 'suspended') {
      teardown(r);
      rec = null; model = null; notice = null; needGesture = true;
      setPhase('idle');
      return;
    }
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const src = ctx.createMediaStreamSource(r.stream);
    r.an = ctx.createAnalyser();
    r.an.fftSize = 1024;
    // No output: the graph never reaches ctx.destination, so nothing is played. Chrome keeps pulling a 0-output worklet.
    r.node = new AudioWorkletNode(ctx, 'pcm-downsampler', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    r.node.port.onmessage = (ev) => {
      // Before `ready` the server drops audio, so it isn't sent (or buffered) at all.
      if (ev.data instanceof ArrayBuffer) { if (r.ready && r.ws?.readyState === WebSocket.OPEN) r.ws.send(ev.data); }
      else if (ev.data?.flushed) r.onFlushed?.();
    };
    src.connect(r.an);
    src.connect(r.node);
  } catch (e) {
    teardown(r);
    if (rec === r) toIdle(() => t('micFailed', e?.message || String(e)));
    return;
  }
  if (rec !== r) { teardown(r); return; }
  openWs(r);
  setPhase('waiting');
}

function openWs(r) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = r.ws = new WebSocket(`${proto}//${location.host}/api/stt/stream?ext=voice-input`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { r.opened = true; };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'model') { if (rec === r && phase === 'waiting') { model = m; render(); } }
    else if (m.type === 'ready') {
      r.ready = true;
      if (rec === r && phase === 'waiting') { r.startedAt = Date.now(); setPhase('recording'); meter(r); }
    } else if (m.type === 'final') onFinal(m);
    else if (m.type === 'error') r.err = m;
  };
  ws.onclose = (ev) => {
    if (rec !== r) return;
    teardown(r);
    let why = null;
    if (r.err) why = sttError(r.err);
    else if (!r.opened) why = () => t('unreachable');
    else if (ev.code !== 1000 && !r.closing) why = () => t('dropped');
    toIdle(why, r.restart && !why);
  };
}

/** One recognized segment -> the chat draft at the caret. The joiner space is ours; the host inserts text verbatim. */
function onFinal(m) {
  const text = typeof m.text === 'string' ? m.text.trim() : '';
  if (!text) return;
  post({ type: 'insert-text', text: lastText && !CJK_END.test(lastText) ? ` ${text}` : text });
  lastText = text;
  recent.push(text);
  if (recent.length > 2) recent.shift();
  renderRecent();
}

/** Stop the current recording. Before `ready` nothing was accepted, so it just ends; after, the mic goes off at once
 *  and the server's last finals are awaited (finishing) before idle. `restart` = record again afterwards. */
async function stop(restart = false) {
  const r = rec;
  if (!r) return;
  if (phase === 'starting') { rec = null; teardown(r); toIdle(null, restart); return; } // start() sees rec !== r
  if (phase !== 'waiting' && phase !== 'recording') return;
  if (!r.ready) { teardown(r); toIdle(null, restart); return; }
  r.restart = restart;
  setPhase('finishing');
  // Drain the worklet's partial batch (sent by the port handler above), then end the stream.
  await Promise.race([new Promise((res) => { r.onFlushed = res; r.node.port.postMessage('flush'); }), sleep(500)]);
  stopAudio(r); // the mic goes off now; the server only has decoding left
  if (r.ws.readyState === WebSocket.OPEN) r.ws.send(JSON.stringify({ type: 'end' }));
  r.finishTimer = setTimeout(() => { r.closing = true; r.ws.close(); }, FINISH_TIMEOUT_MS);
}

function stopAudio(r) {
  cancelAnimationFrame(r.raf);
  r.node?.port.close();
  r.stream?.getTracks().forEach((tr) => tr.stop());
  r.ctx?.close().catch(() => {});
  r.node = r.stream = r.ctx = null;
  $('ind').style.removeProperty('--lvl');
}

function teardown(r) {
  stopAudio(r);
  clearTimeout(r.finishTimer);
  if (r.ws && r.ws.readyState <= WebSocket.OPEN) { r.closing = true; r.ws.close(); }
}

/** Host `close-request` (only sent while we reported busy): finish like Stop, then busy:false lets the host unmount. */
function onCloseRequest() {
  closing = true;
  if (phase === 'recording') { stop(); return; } // toIdle -> setPhase('idle') answers busy:false
  if (phase === 'finishing') { render(); return; } // already ending, same answer
  // Not busy (the request crossed our busy:false, or a restart was starting): end whatever began, answer explicitly.
  if (rec) stop();
  busySent = false;
  post({ type: 'busy', busy: false });
  render();
}

/** Level bar (RMS of the analyser, -60…0 dBFS) and elapsed time, once per frame while recording. */
function meter(r) {
  const buf = new Float32Array(r.an.fftSize);
  let shown = '';
  const tick = () => {
    if (!r.an || rec !== r || phase !== 'recording') return;
    r.an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const db = 10 * Math.log10(sum / buf.length + 1e-10);
    const lvl = Math.max(0, Math.min(1, (db + 60) / 60));
    $('level').style.width = `${Math.round(lvl * 100)}%`;
    $('ind').style.setProperty('--lvl', lvl.toFixed(2));
    const time = fmt(Date.now() - r.startedAt);
    if (time !== shown) $('timer').textContent = shown = time;
    r.raf = requestAnimationFrame(tick);
  };
  tick();
}

async function refreshDevices() {
  const sel = $('mic');
  const prev = sel.value || localStorage.getItem(`${LS}mic`) || '';
  let list = [];
  try {
    list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch { /* keep just "Default" */ }
  sel.replaceChildren(new Option(t('micDefault'), ''), ...list.map((d, i) => new Option(d.label || `${t('micN')} ${i + 1}`, d.deviceId)));
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '';
  render();
}

// ---- about / license -------------------------------------------------------------------------------------------------------

/** Links open in a new tab where the host allows it; the iframe sandbox has no allow-popups, so the URL is also the
 *  visible (selectable) link text. */
const link = (url) => Object.assign(el('a', 'url', url), { href: url, target: '_blank', rel: 'noopener' });

function renderAbout() {
  $('aboutTitle').textContent = t('aboutTitle');
  $('aboutClose').title = $('aboutClose').ariaLabel = t('back');
  $('licenseBack').title = $('licenseBack').ariaLabel = t('back');
  const rows = t('aboutRows').map(([k, v, links, lic]) => {
    const row = el('div', 'row');
    row.append(el('div', 'k', k), el('div', 'v', v));
    for (const [label, url] of links ?? []) {
      const line = el('div', 'v link');
      if (label) line.append(`${label}: `);
      line.append(link(url));
      row.append(line);
    }
    if (lic) {
      const b = el('button', 'textbtn', t('viewLicense'));
      b.type = 'button';
      b.id = 'viewLicense';
      b.onclick = openLicense;
      const line = el('div', 'v');
      line.append(b);
      row.append(line);
    }
    return row;
  });
  $('aboutBody').replaceChildren(...rows, el('p', 'note', t('aboutNote')));
}

let licenseText = null;
async function openLicense() {
  $('license').hidden = false;
  if (licenseText != null) return;
  $('licenseText').textContent = t('loading');
  try {
    const res = await fetch('MODEL_LICENSE.txt');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    licenseText = await res.text();
    $('licenseText').textContent = licenseText;
  } catch (e) {
    $('licenseText').textContent = t('loadFailed', e?.message || String(e));
  }
}

// ---- host ------------------------------------------------------------------------------------------------------------------

// Host theme tokens -> --halo-<token> (style.css derives its palette from them, falling back to built-in values).
let themeKeys = [];
function applyTheme(m) {
  const root = document.documentElement;
  root.dataset.theme = m.theme === 'light' ? 'light' : 'dark';
  const vars = m.themeVars && typeof m.themeVars === 'object' ? m.themeVars : {};
  const keys = Object.keys(vars).filter((k) => /^[a-z-]+$/.test(k) && typeof vars[k] === 'string');
  for (const k of themeKeys) if (!keys.includes(k)) root.style.removeProperty(`--halo-${k}`);
  for (const k of keys) root.style.setProperty(`--halo-${k}`, vars[k]);
  themeKeys = keys;
}

function setLang(l) {
  lang = l === 'en' ? 'en' : 'zh';
  document.documentElement.lang = lang;
  $('aboutBtn').title = $('aboutBtn').ariaLabel = t('about');
  const def = $('mic').options[0];
  if (def) def.textContent = t('micDefault');
  renderAbout();
  render();
}

$('act').onclick = () => { if (phase === 'idle') start(); else stop(); };
$('mic').onchange = () => {
  localStorage.setItem(`${LS}mic`, $('mic').value);
  if (phase === 'recording') stop(true); // the last sentences of the old device still land, then it records on the new one
};
$('aboutBtn').onclick = () => { $('about').hidden = false; };
$('aboutClose').onclick = () => { $('about').hidden = true; };
$('licenseBack').onclick = () => { $('license').hidden = true; };
// The host unmounts the panel on close, which ends the capture anyway; release explicitly so it never lingers.
addEventListener('pagehide', () => { if (rec) teardown(rec); });

addEventListener('message', (e) => {
  if (e.source !== parent || e.data?.haloExt !== 1) return;
  const m = e.data;
  if (m.type === 'init') {
    applyTheme(m);
    setLang(m.lang);
    if (autoStarted) return; // init is re-sent on every ready: start (and wire devicechange) once per iframe
    autoStarted = true;
    if (navigator.mediaDevices) navigator.mediaDevices.addEventListener?.('devicechange', refreshDevices);
    if (m.view === 'chatbar') start(); // the toolbar click that opened us is the "start" (refreshDevices runs after the grant)
    else { setPhase('idle'); if (navigator.mediaDevices) refreshDevices(); }
  } else if (m.type === 'close-request') onCloseRequest();
  else if (m.type === 'theme') applyTheme(m);
  else if (m.type === 'lang') setLang(m.lang);
});

setLang(lang);
post({ type: 'ready', protocol: 1 });
