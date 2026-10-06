// Meeting Recorder — see README.md. Pipeline: mic + (optional) display audio -> one AudioContext (never connected to the
// speakers) -> (a) MediaRecorder opus/webm chunks appended to audio/NNN.webm, (b) AudioWorklet -> 16 kHz s16le PCM ->
// the server's Amazon Transcribe proxy (WS). Final segments / screenshots are appended to the package as they happen.

const post = (m, transfer) => parent.postMessage({ haloExt: 1, ...m }, '*', transfer ?? []);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const enc = (s) => new TextEncoder().encode(s).buffer;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n, w = 2) => String(n).padStart(w, '0');
const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };

// ---- i18n ------------------------------------------------------------------------------------------------------------

const T = {
  en: {
    mic: 'Microphone', sys: 'System / video sound', shots: 'Screenshots', skip: 'Skip unchanged frames', lang: 'Language',
    start: 'Start', resume: 'Resume', pause: 'Pause', stop: 'Stop', copy: 'Copy prompt for agent', copied: 'Copied',
    jump: 'Jump to latest ↓', empty: 'Nothing recorded yet. Pick your sources and press Start.',
    micDefault: 'Default microphone', micNone: 'None (no microphone)', micN: 'Microphone',
    off: 'Off', secs: 's', auto: 'Auto', speaking: 'speaking…',
    sReady: 'Ready', sRec: 'Recording', sPaused: 'Paused', sStopped: 'Stopped', sBusy: 'Working…',
    txOff: '', txConnecting: 'Connecting to Amazon Transcribe…', txLive: 'Live transcription', txRetry: 'Reconnecting', txErr: 'Transcription unavailable',
    retryIn: (s) => `retry in ${s}s`,
    noMedia: 'Recording needs a secure context: open Halo over https or on localhost, or use the Halo desktop app.',
    noSysAudio: 'No system audio in this share (pick a tab / screen with “share audio”). Continuing with the microphone only.',
    shareCancelled: 'Screen / window sharing was cancelled or denied — nothing started.',
    micFailed: (m) => `Cannot open the microphone: ${m}`,
    noSource: 'Pick at least one source: a microphone, system sound or screenshots.',
    shareEnded: 'Screen sharing ended — screenshots and system sound stopped.',
    micEnded: 'The microphone disconnected.',
    credentials: 'AWS credentials missing or invalid — set them in Halo Settings → Extension settings → Meeting Recorder, or give the server machine an AWS role.',
    denied: 'AWS denied access — the credentials need the IAM permission transcribe:StartStreamTranscriptionWebSocket / transcribe:StartStreamTranscription.',
    limit: 'Amazon Transcribe is throttling or at its limit — backing off.',
    unreachable: 'Cannot reach the transcription service (not logged in, extension not allowed, or the server has no transcribe proxy).',
    pkgBad: (m) => `Cannot read this package: ${m}`,
    fsFail: (m) => `Writing to the package failed: ${m}`,
    noRecorder: 'This browser cannot record webm/opus — no audio file will be saved (transcript and screenshots still work).',
    prompt: (p) => `Please read ${p}/transcript.md (the meeting may still be in progress) and summarize what has been said so far`,
  },
  zh: {
    mic: '麦克风', sys: '系统 / 视频声音', shots: '定时截图', skip: '跳过无变化画面', lang: '语言',
    start: '开始', resume: '继续', pause: '暂停', stop: '结束', copy: '复制给 Agent 的提示', copied: '已复制',
    jump: '回到最新 ↓', empty: '还没有记录。选好输入源后点「开始」。',
    micDefault: '默认麦克风', micNone: '不使用麦克风', micN: '麦克风',
    off: '关闭', secs: '秒', auto: '自动', speaking: '正在说…',
    sReady: '就绪', sRec: '录制中', sPaused: '已暂停', sStopped: '已结束', sBusy: '处理中…',
    txOff: '', txConnecting: '正在连接 Amazon Transcribe…', txLive: '实时转写中', txRetry: '正在重连', txErr: '转写不可用',
    retryIn: (s) => `${s} 秒后重试`,
    noMedia: '录制需要安全上下文：请用 https 或 localhost 打开 Halo，或使用 Halo 桌面客户端。',
    noSysAudio: '本次共享没有系统声音（请选择带「共享音频」的标签页 / 屏幕）。仅使用麦克风继续。',
    shareCancelled: '屏幕 / 窗口共享被取消或拒绝，未开始录制。',
    micFailed: (m) => `无法打开麦克风：${m}`,
    noSource: '请至少选择一个输入源：麦克风、系统声音或定时截图。',
    shareEnded: '屏幕共享已结束，截图和系统声音已停止。',
    micEnded: '麦克风已断开。',
    credentials: 'AWS 凭证缺失或无效——请在 Halo「设置 → 扩展设置 → Meeting Recorder」中填写，或给服务器所在机器配置 AWS 角色。',
    denied: 'AWS 拒绝访问——凭证需要 IAM 权限 transcribe:StartStreamTranscriptionWebSocket / transcribe:StartStreamTranscription。',
    limit: 'Amazon Transcribe 触发限流或上限，正在退避重试。',
    unreachable: '无法连接转写服务（未登录、扩展无权限，或服务器没有转写代理）。',
    pkgBad: (m) => `无法读取该会议包：${m}`,
    fsFail: (m) => `写入会议包失败：${m}`,
    noRecorder: '当前浏览器不支持 webm/opus 录音——不会保存音频文件（转写和截图仍可用）。',
    prompt: (p) => `请阅读 ${p}/transcript.md（会议可能仍在进行），概括到目前为止的内容`,
  },
};
let lang = 'zh';
const t = (k, ...a) => { const v = T[lang][k]; return typeof v === 'function' ? v(...a) : v; };

const LANGS = [['auto', null], ['zh-CN', '中文'], ['en-US', 'English'], ['zh-HK', '粤语'], ['ja-JP', '日本語'], ['ko-KR', '한국어']];
const SHOTS = [0, 20, 30, 60];

// ---- package fs (host `fs` frames) --------------------------------------------------------------------------------------

let fsSeq = 0;
const fsPending = new Map();
const fsCall = (op, path, buffer) => new Promise((resolve, reject) => {
  const id = ++fsSeq;
  fsPending.set(id, { resolve, reject });
  post({ type: 'fs', id, op, path, ...(buffer ? { buffer } : {}) }, buffer ? [buffer] : []);
});
const chains = new Map();
/** Run `fn` after everything previously queued for `path` (appends to one file stay ordered). */
const enqueue = (path, fn) => {
  const p = (chains.get(path) ?? Promise.resolve()).then(fn).catch((e) => { console.warn('[htrans] fs', path, e); setNotice('fs', t('fsFail', e.message)); })
    .finally(() => { if (chains.get(path) === p) chains.delete(path); }); // one-shot paths (shots/*) must not pile up over hours
  chains.set(path, p);
  return p;
};
const appendText = (path, s) => enqueue(path, () => fsCall('append', path, enc(s)));
const drainWrites = () => Promise.all([...chains.values()]);

let meeting = null;
let meetingWrite = null; // in-flight promise; saves requested meanwhile coalesce into one follow-up write
let meetingAgain = false;
const saveMeeting = () => {
  if (meetingWrite) { meetingAgain = true; return meetingWrite; }
  meetingWrite = (async () => {
    try {
      do {
        meetingAgain = false;
        try { await fsCall('write', 'meeting.json', enc(JSON.stringify(meeting, null, 2))); } catch (e) { console.warn('[htrans] meeting.json', e); setNotice('fs', t('fsFail', e.message)); }
      } while (meetingAgain);
    } finally { meetingWrite = null; }
  })();
  return meetingWrite;
};

// ---- notices / status ---------------------------------------------------------------------------------------------------

const notices = new Map();
function setNotice(key, msg, kind = 'warn') {
  if (msg) notices.set(key, { msg, kind }); else notices.delete(key);
  const box = $('notice');
  box.replaceChildren(...[...notices.values()].map((n) => el('div', null, n.msg)));
  box.className = 'notice' + ([...notices.values()].some((n) => n.kind === 'err') ? ' err' : '');
  box.hidden = notices.size === 0;
}
let toastTimer = 0;
function toast(msg) { const n = $('toast'); n.textContent = msg; n.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { n.hidden = true; }, 1600); }

// ---- state ------------------------------------------------------------------------------------------------------------------

let bundlePath = '';
let title = '';
let phase = 'idle'; // idle | starting | recording | stopping | paused | stopped
let rec = null; // the active run (runtime objects), null when not recording
const tx = { ws: null, state: 'off', ready: false, startWall: 0, failures: 0, backoff: 1000, retryAt: 0, readyAt: 0, err: null, closing: false, onClosed: null };

const setPhase = (p) => { phase = p; renderControls(); };

function renderControls() {
  const running = phase === 'recording';
  const idle = phase === 'idle' || phase === 'paused' || phase === 'stopped';
  const hasRuns = (meeting?.runs.length ?? 0) > 0;
  $('start').textContent = meeting?.runs.some((r) => r.endedAt) ? t('resume') : t('start');
  $('pause').textContent = t('pause');
  $('stop').textContent = t('stop');
  $('start').disabled = !idle || !meeting || !navigator.mediaDevices;
  $('pause').disabled = !running;
  $('stop').disabled = !running;
  for (const id of ['mic', 'micRefresh', 'sys', 'shot', 'lang']) $(id).disabled = !idle;
  showEmpty(entryCount === 0 && idle);
  const label = phase === 'recording' ? 'sRec' : phase === 'starting' || phase === 'stopping' ? 'sBusy' : phase === 'paused' ? 'sPaused' : hasRuns || phase === 'stopped' ? 'sStopped' : 'sReady';
  $('status').textContent = t(label);
  $('status').className = 'pill' + (running ? ' recording' : '');
}

function totalMs() {
  const now = Date.now();
  return (meeting?.runs ?? []).reduce((a, r) => a + Math.max(0, (r.endedAt ?? now) - r.startedAt), 0);
}
let lastUi = 0;
function renderTicker(force) {
  const now = Date.now();
  if (!force && now - lastUi < 900) return;
  lastUi = now;
  $('elapsed').textContent = fmt(totalMs());
  let txt = '', cls = 'txstatus';
  const wait = tx.retryAt > now ? Math.ceil((tx.retryAt - now) / 1000) : 0;
  if (rec) {
    if (tx.state === 'connecting') txt = t('txConnecting');
    else if (tx.state === 'live') { txt = t('txLive'); cls += ' live'; }
    else if (tx.state === 'reconnecting') txt = `${t('txRetry')}… ${wait ? t('retryIn', wait) : ''}`;
    else if (tx.state === 'error') { txt = `${t('txErr')} — ${t('retryIn', wait)}`; cls += ' bad'; }
  }
  const s = $('txStatus');
  if (s.textContent !== txt) s.textContent = txt;
  s.className = cls;
}

// ---- transcript log ---------------------------------------------------------------------------------------------------------

const log = $('log');
const partialEl = el('div', 'partial');
log.append(partialEl);
let stick = true;
let emptyEl = null;
let entryCount = 0;
const showEmpty = (on) => { if (on && !emptyEl) { emptyEl = el('div', 'empty', t('empty')); log.insertBefore(emptyEl, partialEl); } else if (!on && emptyEl) { emptyEl.remove(); emptyEl = null; } };
log.addEventListener('scroll', () => {
  stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  $('jump').hidden = stick;
}, { passive: true });
$('jump').onclick = () => { stick = true; $('jump').hidden = true; log.scrollTop = log.scrollHeight; };
let scrollQueued = false;
const maybeScroll = () => {
  if (!stick || scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => { scrollQueued = false; if (stick) log.scrollTop = log.scrollHeight; });
};

// Screenshot thumbnails load lazily (fs read -> blob URL) and are released again when far off-screen, so a many-hour
// meeting doesn't keep hundreds of decoded JPEGs alive.
const io = new IntersectionObserver((entries) => {
  for (const en of entries) {
    const img = en.target;
    if (en.isIntersecting) loadShot(img); else unloadShot(img);
  }
}, { root: log, rootMargin: '900px 0px' });
async function loadShot(img) {
  if (img.dataset.state) return;
  img.dataset.state = 'loading';
  try {
    const r = await fsCall('read', img.dataset.shot);
    if (img.dataset.state !== 'loading') return;
    const url = URL.createObjectURL(new Blob([r.buffer], { type: 'image/jpeg' }));
    img.onload = () => { img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`; img.onload = null; };
    img.src = url;
    img.dataset.state = 'loaded';
  } catch { img.dataset.state = ''; }
}
function unloadShot(img) {
  if (img.dataset.state === 'loading') { img.dataset.state = ''; return; }
  if (img.dataset.state !== 'loaded') return;
  URL.revokeObjectURL(img.src);
  img.removeAttribute('src');
  img.dataset.state = '';
}

function addEntry(e) {
  entryCount++;
  showEmpty(false);
  const row = el('div', e.shot ? 'line shot' : 'line');
  row.append(el('span', 'ts', `[${fmt(e.t)}]`));
  if (e.shot) {
    const img = el('img');
    img.dataset.shot = e.shot;
    img.alt = e.shot;
    img.onclick = () => { if (img.src) { $('lightbox').querySelector('img').src = img.src; $('lightbox').hidden = false; } };
    row.append(img);
    io.observe(img);
  } else row.append(el('span', 'tx', e.text));
  log.insertBefore(row, partialEl);
  maybeScroll();
}
$('lightbox').onclick = () => { $('lightbox').hidden = true; };

// ---- package lifecycle ------------------------------------------------------------------------------------------------------

const README = `# Meeting package · 会议记录包 (htrans)

Recorded by the Halo "Meeting Recorder" extension. 由 Halo「Meeting Recorder」扩展录制。

| File / 文件 | What it is / 说明 |
|---|---|
| \`transcript.md\` | **Read this. / 请读这个。** Timeline \`[HH:MM:SS] text\` and screenshot lines \`[HH:MM:SS] 📷 shots/NNNNNN.jpg\`. Offsets count from \`meeting.json\`.startedAt. 时间线，偏移量从 startedAt 起算。 |
| \`transcript.jsonl\` | Same content, one JSON per line: \`{"t","end","at","text","lang"}\` or \`{"t","at","shot"}\` (\`t\`/\`end\` = ms since startedAt, \`at\` = epoch ms). 同样内容，机器可读。 |
| \`meeting.json\` | Metadata: \`status\`, \`startedAt\`, \`runs[]\` (one per start/resume; \`interrupted:true\` = cut off by a crash or reload), screenshot interval, language. 元数据。 |
| \`audio/NNN.webm\` | Audio of run NNN (opus). 每次录制一个音频文件。 |
| \`shots/NNNNNN.jpg\` | Screenshots; the number is the offset in seconds since startedAt. 截图，文件名 = 距 startedAt 的秒数。 |
| \`notes.md\` | Put your notes / summary here (optional, written by you). 你的笔记 / 总结写在这里。 |

## Notes for an agent · 给 Agent 的说明

- The meeting may still be in progress. Check \`meeting.json\` → \`status\`: \`recording\` = live, \`transcript.md\` is still growing (re-read it for newer content); \`stopped\` = not recording right now (paused or finished).
  会议可能仍在进行：看 \`meeting.json\` 的 \`status\`，\`recording\` 表示正在录制，\`transcript.md\` 还在增长。
- To relate a screenshot to the discussion, take its offset (the number in the file name, seconds) and read the \`transcript.md\` lines around that \`[HH:MM:SS]\`.
  要把截图和讨论对应起来，用文件名里的秒数，去看 \`transcript.md\` 中相近时间的内容。
- The transcript is machine output from Amazon Transcribe and may contain errors (names, numbers, mixed languages). Do not treat it as verbatim.
  转写由 Amazon Transcribe 机器生成，可能有错误（人名、数字、中英混说），请勿当作逐字稿。
- Write your own notes to \`notes.md\`; leave the other files untouched (the recorder is still appending to them while recording).
  请把笔记写到 \`notes.md\`，不要改动其他文件（录制中会继续追加）。
`;

async function loadPackage() {
  let raw = null;
  try { raw = new Uint8Array((await fsCall('read', 'meeting.json')).buffer); } catch (e) { if (e.code !== 'not-found') { setNotice('pkg', t('pkgBad', e.message), 'err'); renderControls(); return; } }
  if (!raw) {
    meeting = { format: 'htrans', version: 1, title, createdAt: new Date().toISOString(), status: 'idle', runs: [], shotIntervalSec: 0, asr: { engine: 'aws-transcribe', language: 'auto' } };
    await Promise.all([saveMeeting(), enqueue('README.md', () => fsCall('write', 'README.md', enc(README)))]);
  } else {
    try { meeting = JSON.parse(new TextDecoder().decode(raw)); if (!Array.isArray(meeting.runs)) meeting.runs = []; } catch (e) { setNotice('pkg', t('pkgBad', e.message), 'err'); renderControls(); return; }
  }
  let entries = [];
  try {
    const text = new TextDecoder().decode((await fsCall('read', 'transcript.jsonl')).buffer);
    for (const line of text.split('\n')) { if (!line.trim()) continue; try { entries.push(JSON.parse(line)); } catch { /* torn last line after a crash */ } }
  } catch (e) { if (e.code !== 'not-found') setNotice('pkg', t('pkgBad', e.message), 'err'); }
  // A previous session died while recording (crash / reload): close its run off the last thing it managed to write.
  if (meeting.status === 'recording') {
    const run = meeting.runs[meeting.runs.length - 1];
    if (run && !run.endedAt) {
      const last = entries.reduce((m, e) => Math.max(m, e.at != null ? e.at + (e.end != null && e.t != null ? e.end - e.t : 0) : 0), 0);
      run.interrupted = true;
      run.endedAt = Math.max(run.startedAt, last || Date.now());
    }
    meeting.status = 'stopped';
    await saveMeeting();
  }
  $('shot').value = String(meeting.shotIntervalSec ?? 0);
  if (meeting.asr?.language) $('lang').value = meeting.asr.language;
  if (!$('lang').value) $('lang').value = 'auto';
  for (const e of entries) addEntry(e);
  stick = true;
  log.scrollTop = log.scrollHeight;
  phase = meeting.runs.length ? 'stopped' : 'idle';
  renderControls();
  renderTicker(true);
}

// ---- devices ---------------------------------------------------------------------------------------------------------------------

async function refreshDevices() {
  const sel = $('mic');
  const prev = sel.value;
  sel.replaceChildren(new Option(t('micDefault'), ''), new Option(t('micNone'), 'none'));
  try {
    const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    list.forEach((d, i) => sel.append(new Option(d.label || `${t('micN')} ${i + 1}`, d.deviceId)));
  } catch { /* keep the two static options */ }
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '';
}

// ---- screenshots -----------------------------------------------------------------------------------------------------------------

const thumbCanvas = Object.assign(document.createElement('canvas'), { width: 32, height: 18 });
const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
function thumbOf(src) {
  thumbCtx.drawImage(src, 0, 0, 32, 18);
  const d = thumbCtx.getImageData(0, 0, 32, 18).data;
  const g = new Uint8Array(576);
  for (let i = 0; i < 576; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  return g;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function grabFrame(r) {
  const vt = r.display?.getVideoTracks()[0];
  if (!vt || vt.readyState !== 'live') return null;
  if ('ImageCapture' in window) {
    try {
      r.ic ??= new ImageCapture(vt);
      const bmp = await withTimeout(r.ic.grabFrame(), 3000);
      return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
    } catch { /* fall through to the <video> path */ }
  }
  if (!r.video) {
    r.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, className: 'hidden-video' });
    r.video.srcObject = new MediaStream([vt]);
    document.body.append(r.video);
    await r.video.play().catch(() => {});
  }
  if (!r.video.videoWidth) return null;
  return { src: r.video, w: r.video.videoWidth, h: r.video.videoHeight, done() {} };
}

async function takeShot(r) {
  const frame = await grabFrame(r);
  if (!frame) return;
  try {
    const th = thumbOf(frame.src);
    if ($('skip').checked && r.prevThumb) {
      let sum = 0;
      for (let i = 0; i < 576; i++) sum += Math.abs(th[i] - r.prevThumb[i]);
      if (sum / 576 < 1) return;
    }
    r.prevThumb = th;
    const scale = Math.min(1, 1600 / frame.w);
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(frame.w * scale), height: Math.round(frame.h * scale) });
    c.getContext('2d').drawImage(frame.src, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
    if (!blob) return;
    const at = Date.now();
    const off = at - meeting.startedAt;
    const path = `shots/${pad(Math.floor(off / 1000), 6)}.jpg`;
    const buf = await blob.arrayBuffer();
    await enqueue(path, () => fsCall('write', path, buf));
    const e = { t: off, at, shot: path };
    appendText('transcript.md', `[${fmt(off)}] 📷 ${path}\n`);
    appendText('transcript.jsonl', JSON.stringify(e) + '\n');
    addEntry(e);
  } finally { frame.done(); }
}

// ---- transcription (WS proxy) ---------------------------------------------------------------------------------------------

function txOpen() {
  const lang = $('lang').value;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/transcribe/stream?ext=htrans&lang=${encodeURIComponent(lang)}`);
  ws.binaryType = 'arraybuffer';
  Object.assign(tx, { ws, state: 'connecting', ready: false, startWall: 0, err: null, closing: false, retryAt: 0 });
  ws.onmessage = (ev) => {
    if (tx.ws !== ws || typeof ev.data !== 'string') return;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'ready') { tx.ready = true; tx.state = 'live'; tx.readyAt = Date.now(); tx.failures = 0; setNotice('tx', null); }
    else if (m.type === 'partial') partialEl.textContent = m.text || '';
    else if (m.type === 'final') onFinal(m);
    else if (m.type === 'error') tx.err = m;
    renderTicker(true);
  };
  const closed = () => {
    if (tx.ws !== ws) return;
    const livedMs = tx.ready ? Date.now() - tx.readyAt : 0;
    const wasReady = tx.ready;
    Object.assign(tx, { ws: null, ready: false, startWall: 0 });
    partialEl.textContent = '';
    tx.onClosed?.(); tx.onClosed = null;
    if (tx.closing || !rec) { tx.state = 'off'; return; }
    // Reconnect policy: transient drops (incl. Transcribe's 4 h cap) retry after ~1 s doubling to 30 s; auth / permission
    // errors retry only every 60 s so a bad key doesn't spin.
    const code = tx.err?.code;
    if (!wasReady && !tx.err) tx.failures++;
    if (livedMs > 20000) tx.backoff = 1000;
    let delay = tx.backoff;
    tx.backoff = Math.min(tx.backoff * 2, 30000);
    tx.state = 'reconnecting';
    if (code === 'credentials' || code === 'denied' || code === 'bad-request') { delay = 60000; tx.state = 'error'; }
    else if (code === 'limit') { delay = Math.max(delay, 15000); tx.state = 'error'; }
    if (code === 'credentials' || code === 'denied' || code === 'limit') setNotice('tx', t(code), 'err');
    else if (code) setNotice('tx', tx.err.message || code, 'err');
    else if (tx.failures >= 2) setNotice('tx', t('unreachable'), 'err');
    tx.retryAt = Date.now() + delay;
    renderTicker(true);
  };
  ws.onclose = closed;
  ws.onerror = () => { /* onclose always follows */ };
}

function onFinal(m) {
  const text = (m.text || '').trim();
  partialEl.textContent = '';
  if (!text || !tx.startWall) return;
  const at = Math.round(tx.startWall + m.start * 1000);
  const off = at - meeting.startedAt;
  const e = { t: off, end: Math.round(tx.startWall + m.end * 1000 - meeting.startedAt), at, text, lang: m.lang || $('lang').value };
  appendText('transcript.md', `[${fmt(off)}] ${text}\n`);
  appendText('transcript.jsonl', JSON.stringify(e) + '\n');
  addEntry(e);
}

function onPcm(buf) {
  const ws = tx.ws;
  // Stream as soon as the socket is open — Transcribe only accepts (and the proxy only says `ready`) once audio flows.
  if (!ws || ws.readyState !== 1 || ws.bufferedAmount > (1 << 20)) return; // disconnected: drop, never buffer hours of audio
  if (!tx.startWall) tx.startWall = Date.now() - buf.byteLength / 32; // 16 kHz s16 = 32 bytes/ms; stream time 0 = first byte sent
  ws.send(buf);
}

async function txFinish() {
  const ws = tx.ws;
  tx.closing = true;
  if (!ws) { tx.state = 'off'; return; }
  const closed = new Promise((r) => { tx.onClosed = r; });
  if (ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'end' })); } catch { /* closing anyway */ } }
  else ws.close();
  await Promise.race([closed, sleep(8000)]);
  if (tx.ws === ws) { tx.ws = null; try { ws.close(); } catch { /* */ } }
  tx.state = 'off';
}

// ---- start / stop -----------------------------------------------------------------------------------------------------------------

function stopTracks(...streams) { for (const s of streams) s?.getTracks().forEach((tr) => tr.stop()); }

async function start() {
  if (phase !== 'idle' && phase !== 'paused' && phase !== 'stopped') return;
  const wantMic = $('mic').value !== 'none';
  const wantSys = $('sys').checked;
  const shotSec = Number($('shot').value);
  if (!wantMic && !wantSys && !shotSec) { setNotice('start', t('noSource')); return; }
  setNotice('start', null); setNotice('fs', null);
  setPhase('starting');
  let display = null, micStream = null, ctx = null;
  try {
    // getDisplayMedia needs the click's user activation, so it goes first (the mic prompt can take longer than it lasts).
    if (wantSys || shotSec) {
      try { display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: wantSys }); }
      catch { setNotice('start', t('shareCancelled')); setPhase(meeting.runs.length ? 'stopped' : 'idle'); return; }
      if (!shotSec) display.getVideoTracks().forEach((tr) => tr.stop()); // only the sound is wanted
    }
    const sysTracks = wantSys && display ? display.getAudioTracks() : [];
    if (wantSys && !sysTracks.length) setNotice('sys', t('noSysAudio'));
    else setNotice('sys', null);
    if (wantMic) {
      const id = $('mic').value;
      try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { ...(id ? { deviceId: { exact: id } } : {}), echoCancellation: true, noiseSuppression: true } }); }
      catch (e) { stopTracks(display); setNotice('start', t('micFailed', e.message || e.name)); setPhase(meeting.runs.length ? 'stopped' : 'idle'); return; }
      refreshDevices(); // labels are available now
    }
    const hasAudio = !!micStream || sysTracks.length > 0;
    if (!hasAudio && !(shotSec && display?.getVideoTracks().length)) { stopTracks(display); setNotice('start', t('noSource')); setPhase(meeting.runs.length ? 'stopped' : 'idle'); return; }

    const now = Date.now();
    meeting.startedAt ??= now;
    const idx = meeting.runs.length + 1;
    const audio = hasAudio ? `audio/${pad(idx, 3)}.webm` : undefined;
    const run = { startedAt: now, ...(audio ? { audio } : {}), sources: [...(micStream ? ['mic'] : []), ...(sysTracks.length ? ['system'] : []), ...(shotSec && display ? ['screen'] : [])] };
    meeting.runs.push(run);
    meeting.status = 'recording';
    meeting.shotIntervalSec = shotSec;
    meeting.asr = { engine: 'aws-transcribe', language: $('lang').value };
    const r = rec = { run, display, micStream, shotSec, nextShotAt: shotSec ? now + 1500 : 0, shotBusy: null, prevThumb: null, pcm: 0 };

    if (hasAudio) {
      ctx = r.ctx = new AudioContext({ latencyHint: 'playback' });
      await ctx.audioWorklet.addModule('pcm-worklet.js');
      await ctx.resume();
      const mix = ctx.createGain();
      const meter = (stream, key) => {
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        src.connect(an); src.connect(mix);
        r[key] = { an, buf: new Float32Array(1024) };
      };
      if (micStream) meter(micStream, 'micM');
      if (sysTracks.length) meter(new MediaStream(sysTracks), 'sysM');
      // No output node: the graph is never connected to ctx.destination, so nothing is ever played. The worklet has
      // zero outputs and Chrome keeps pulling such a node.
      const node = r.node = new AudioWorkletNode(ctx, 'pcm-downsampler', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) { r.pcm++; onPcm(ev.data); tick(); }
        else if (ev.data?.flushed) r.onFlushed?.();
      };
      mix.connect(node);
      const dest = ctx.createMediaStreamDestination();
      mix.connect(dest);
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        const mr = r.recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 });
        mr.ondataavailable = (ev) => { if (ev.data.size) enqueue(audio, async () => fsCall('append', audio, await ev.data.arrayBuffer())); };
        r.recorderStopped = new Promise((res) => { mr.onstop = res; });
        mr.start(5000);
      } else setNotice('rec', t('noRecorder'));
    }
    micStream?.getAudioTracks()[0]?.addEventListener('ended', () => setNotice('end-mic', t('micEnded')));
    display?.getVideoTracks()[0]?.addEventListener('ended', () => { r.nextShotAt = 0; setNotice('end-share', t('shareEnded')); });
    r.tickTimer = setInterval(tick, 1000);
    sysTracks[0]?.addEventListener('ended', () => setNotice('end-share', t('shareEnded')));
    Object.assign(tx, { backoff: 1000, failures: 0 });
    if (hasAudio) txOpen();
    post({ type: 'dirty', dirty: true });
    setPhase('recording');
    renderTicker(true);
    await saveMeeting();
  } catch (e) {
    console.warn('[htrans] start failed', e);
    setNotice('start', t('micFailed', e.message || String(e)), 'err');
    if (rec) await endRun('stop'); else { stopTracks(display, micStream); ctx?.close(); setPhase(meeting.runs.length ? 'stopped' : 'idle'); }
  }
}

async function endRun(kind) {
  const r = rec;
  if (!r || phase === 'stopping') return;
  setPhase('stopping');
  clearInterval(r.tickTimer);
  r.nextShotAt = 0;
  await r.shotBusy?.catch(() => {});
  if (r.node) { // drain the worklet's partial batch so the last words reach Transcribe, then close the stream cleanly
    await Promise.race([new Promise((res) => { r.onFlushed = res; r.node.port.postMessage('flush'); }), sleep(500)]);
  }
  if (r.recorder && r.recorder.state !== 'inactive') { r.recorder.stop(); await Promise.race([r.recorderStopped, sleep(3000)]); }
  await txFinish();
  rec = null;
  r.node?.port.close();
  stopTracks(r.micStream, r.display);
  r.video?.remove();
  r.ctx?.close().catch(() => {});
  partialEl.textContent = '';
  r.run.endedAt = Date.now();
  meeting.status = 'stopped';
  setNotice('tx', null);
  await saveMeeting();
  await drainWrites();
  post({ type: 'dirty', dirty: false });
  setPhase(kind === 'pause' ? 'paused' : 'stopped');
  renderTicker(true);
}

// Everything time-driven hangs off one tick: a 1 s interval plus every PCM batch from the worklet (~150 ms). Timers in a
// background tab get throttled; worklet messages don't, so screenshots and reconnects keep their schedule.
function tick() {
  const r = rec;
  if (!r || phase !== 'recording') return;
  const now = Date.now();
  if (r.nextShotAt && now >= r.nextShotAt && !r.shotBusy) {
    r.nextShotAt = now + r.shotSec * 1000;
    r.shotBusy = takeShot(r).catch((e) => console.warn('[htrans] shot', e)).finally(() => { r.shotBusy = null; });
  }
  if (!tx.ws && tx.state !== 'off' && tx.retryAt && now >= tx.retryAt) txOpen();
  renderTicker();
}

// ---- meters (rAF, ~12 fps worth of work) -------------------------------------------------------------------------------

let lastMeter = 0;
function level(m) {
  m.an.getFloatTimeDomainData(m.buf);
  let s = 0;
  for (let i = 0; i < m.buf.length; i++) s += m.buf[i] * m.buf[i];
  const db = 20 * Math.log10(Math.sqrt(s / m.buf.length) + 1e-9);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}
function meterLoop(ts) {
  requestAnimationFrame(meterLoop);
  if (ts - lastMeter < 80) return;
  lastMeter = ts;
  const r = rec;
  $('micMeter').style.width = r?.micM ? `${Math.round(level(r.micM) * 100)}%` : '0';
  $('sysMeter').style.width = r?.sysM ? `${Math.round(level(r.sysM) * 100)}%` : '0';
}
requestAnimationFrame(meterLoop);

// ---- wiring --------------------------------------------------------------------------------------------------------------------

function applyLang() {
  document.documentElement.lang = lang;
  for (const n of document.querySelectorAll('[data-i]')) n.textContent = t(n.dataset.i);
  $('copyPrompt').textContent = t('copy');
  $('jump').textContent = t('jump');
  const sel = $('shot'), cur = sel.value || '0';
  sel.replaceChildren(...SHOTS.map((s) => new Option(s ? `${s} ${t('secs')}` : t('off'), String(s))));
  sel.value = cur;
  const ls = $('lang'), lcur = ls.value || 'auto';
  ls.replaceChildren(...LANGS.map(([v, label]) => new Option(label ?? t('auto'), v)));
  ls.value = lcur;
  partialEl.dataset.ph = t('speaking');
  if (emptyEl) emptyEl.textContent = t('empty');
  renderControls();
}

$('start').onclick = start;
$('pause').onclick = () => endRun('pause');
$('stop').onclick = () => endRun('stop');
$('micRefresh').onclick = refreshDevices;
$('copyPrompt').onclick = async () => {
  const text = t('prompt', bundlePath);
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(t('copied'));
};

addEventListener('message', (e) => {
  if (e.source !== parent || e.data?.haloExt !== 1) return;
  const m = e.data;
  if (m.type === 'fs-result') {
    const p = fsPending.get(m.id);
    if (!p) return;
    fsPending.delete(m.id);
    if (m.ok) p.resolve(m);
    else p.reject(Object.assign(new Error(m.error), { code: m.code }));
  } else if (m.type === 'theme') document.documentElement.dataset.theme = m.theme;
  else if (m.type === 'init') {
    document.documentElement.dataset.theme = m.theme;
    lang = m.lang === 'en' ? 'en' : 'zh';
    bundlePath = m.file.path;
    title = m.file.name.replace(/\.htrans$/i, '');
    $('title').textContent = title;
    document.title = title;
    applyLang();
    if (!navigator.mediaDevices) { setNotice('media', t('noMedia'), 'err'); }
    else { refreshDevices(); navigator.mediaDevices.addEventListener?.('devicechange', refreshDevices); }
    loadPackage();
  }
});

post({ type: 'ready', protocol: 1 });
