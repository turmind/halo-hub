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
    mic: 'Microphone', sys: 'System / video sound', shots: 'Screenshots', skip: 'Skip unchanged frames', lang: 'Language', speakers: 'Identify speakers',
    start: 'Start', resume: 'Resume', pause: 'Pause', copy: 'Copy prompt for agent', copied: 'Copied',
    jump: 'Jump to latest ↓', empty: 'Nothing recorded yet. Pick your sources and press Start.',
    micDefault: 'Default microphone', micNone: 'None (no microphone)', micN: 'Microphone',
    off: 'Off', secs: 's', speaking: 'speaking…',
    langs: { auto: 'Auto (Mandarin / Cantonese / English)', 'zh-CN': 'Mandarin + English', 'zh-HK': 'Cantonese + English', 'en-US': 'English' },
    langHelp: 'Which language setting is most accurate?',
    langTip: [
      'Mandarin + English: Mandarin speakers, with English words or whole English sentences mixed in.',
      'Cantonese + English: the same for Cantonese speakers.',
      'Auto: Mandarin, Cantonese and English all come up in the meeting — each stretch of speech is detected on its own (about 1 s of speech each).',
      'English: the whole meeting is in English.',
    ],
    sReady: 'Ready', sRec: 'Recording', sStopped: 'Stopped', sBusy: 'Working…',
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
    unsaved: (min, m) => `The last ${min} min of recording is not saved yet (${m}) — it is kept on this page and retried.`,
    authExpired: 'Your login has expired: open Halo in a new tab and log in again — do not reload or close this page; the data is written as soon as you are logged in.',
    authMaybe: 'Most likely your login has expired: open Halo in a new tab and log in again — do not reload or close this page; the data is written as soon as you are logged in.',
    saved: 'Unsaved data written',
    restored: (min) => `Restored unsaved data from last time (about ${min} min)`,
    noRecorder: 'This browser cannot record webm/opus — no audio file will be saved (transcript and screenshots still work).',
    prompt: (p) => `Please read ${p}/transcript.md (the meeting may still be in progress) and summarize what has been said so far`,
    appName: 'Meeting Recorder', copyShort: 'Copy prompt', refresh: 'Refresh microphone list', elapsed: 'Recorded time',
    shotAlt: (ts) => `Screenshot at ${ts}`, shotFail: 'Screenshot unavailable', closeHint: 'Click or press Esc to close',
    speaker: (n) => `Speaker ${n}`,
    sysTip: 'After Start a share dialog opens: pick a tab or the entire screen and tick “Share audio”.',
    capNoSys: 'This browser can’t record system / video sound (needs desktop Chrome / Edge, or the Halo desktop app).',
    capNone: 'This browser can’t record system / video sound or take screenshots (needs desktop Chrome / Edge, or the Halo desktop app).',
  },
  zh: {
    mic: '麦克风', sys: '系统 / 视频声音', shots: '定时截图', skip: '跳过无变化画面', lang: '语言', speakers: '区分说话人',
    start: '开始', resume: '继续', pause: '暂停', copy: '复制给 Agent 的提示', copied: '已复制',
    jump: '回到最新 ↓', empty: '还没有记录。选好输入源后点「开始」。',
    micDefault: '默认麦克风', micNone: '不使用麦克风', micN: '麦克风',
    off: '关闭', secs: '秒', speaking: '正在说…',
    langs: { auto: '自动（普通话 / 粤语 / 英语）', 'zh-CN': '普通话 + 英语', 'zh-HK': '粤语 + 英语', 'en-US': 'English' },
    langHelp: '语言怎么选最准？',
    langTip: [
      '普通话 + 英语：讲普通话为主，夹英文词或整句英文都可以。',
      '粤语 + 英语：讲粤语为主，夹英文词或整句英文都可以。',
      '自动：会上普通话、粤语、英语都有人讲，每段话单独识别语言（每段至少说 1 秒左右）。',
      'English：全程英语。',
    ],
    sReady: '就绪', sRec: '录制中', sStopped: '已结束', sBusy: '处理中…',
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
    unsaved: (min, m) => `最近 ${min} 分钟的录音还没保存（${m}），已暂存在本页并持续重试。`,
    authExpired: '登录已过期：请在新标签页打开 Halo 重新登录，不要刷新或关闭这一页；登录后会自动补写。',
    authMaybe: '多半是登录过期：请在新标签页打开 Halo 重新登录，不要刷新或关闭这一页；登录后会自动补写。',
    saved: '已补写完成',
    restored: (min) => `已恢复上次未保存的数据（约 ${min} 分钟）`,
    noRecorder: '当前浏览器不支持 webm/opus 录音——不会保存音频文件（转写和截图仍可用）。',
    prompt: (p) => `请阅读 ${p}/transcript.md（会议可能仍在进行），概括到目前为止的内容`,
    appName: '会议录音', copyShort: '复制提示', refresh: '刷新麦克风列表', elapsed: '已录时长',
    shotAlt: (ts) => `截图 ${ts}`, shotFail: '截图无法加载', closeHint: '点击或按 Esc 关闭',
    speaker: (n) => `说话人 ${n}`,
    sysTip: '点开始后会弹出共享窗口：选标签页或整个屏幕，并勾选「分享音频」。',
    capNoSys: '此浏览器不能录系统 / 视频声音（需 Chrome / Edge 电脑版，或 Halo 桌面客户端）。',
    capNone: '此浏览器不能录系统 / 视频声音，也不能截屏（需 Chrome / Edge 电脑版，或 Halo 桌面客户端）。',
  },
};
let lang = 'zh';
const t = (k, ...a) => { const v = T[lang][k]; return typeof v === 'function' ? v(...a) : v; };

// Picker values are what meeting.json stores (kept stable for old packages); TX_LANG is what the proxy gets. Auto =
// IdentifyMultipleLanguages over the server's auto_languages (default zh-CN,zh-HK,en-US — Cantonese must be a candidate
// or it comes out as garbled Mandarin); Mandarin / Cantonese = that language + English, identified per stretch.
const LANGS = ['zh-CN', 'auto', 'zh-HK', 'en-US'];
// New meetings, packages without a recorded language and any invalid value fall back to this; a package's recorded
// meeting.asr.language always wins (older packages keep 'auto').
const DEFAULT_LANG = 'zh-CN';
const TX_LANG = { 'zh-CN': 'zh-CN,en-US', 'zh-HK': 'zh-HK,en-US' };
const SHOTS = [0, 10, 20, 30, 60];

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
  const p = (chains.get(path) ?? Promise.resolve()).then(fn).catch((e) => { console.warn('[htrans] fs', path, e); setNotice('fs', () => t('fsFail', e.message)); })
    .finally(() => { if (chains.get(path) === p) { chains.delete(path); settled(path); } }); // one-shot paths (shots/*) must not pile up over hours
  chains.set(path, p);
  return p;
};

// Failed writes are kept and retried in order — an expired login (the host answers 401, or a proxy redirects to its SSO
// page) fails every request with `io` while the transcription WS, opened earlier, keeps working; dropping the chunks
// left holes in the audio and the transcript. Other codes (not-found / denied / invalid-path) still drop the chunk.
const sizes = new Map(); // path -> file size after the last acknowledged append (dedupes a resend)
const failing = new Map(); // path -> epoch ms of its oldest unsaved data (the chunk being retried), until its queue is empty
let failErr = null;
function unsaved(path, at, e) {
  failing.set(path, at); // sends are serial: the chunk failing now is the oldest one not saved on this path
  failErr = e;
  setNotice('save', () => `${t('unsaved', Math.max(1, Math.round((Date.now() - Math.min(...failing.values())) / 60000)), failErr.message)} ${t(failErr.auth ? 'authExpired' : 'authMaybe')}`, 'err');
}
function settled(path) {
  if (!failing.delete(path) || failing.size) return;
  setNotice('save', null);
  toast(t('saved'));
}
/** Send one write / append, retrying `io` failures (1 s doubling to 30 s) until it lands. An append that may already
 *  have landed unacknowledged (an earlier attempt, or the last request of a page that went away) is checked first: file
 *  size = last acknowledged size + this chunk means it did. Returns false when it had. */
async function send(path, op, bytes, at, maybeLanded = false) {
  for (let delay = 1000; ; delay = Math.min(delay * 2, 30000)) {
    try {
      if (maybeLanded && op === 'append' && sizes.has(path)) {
        const st = await fsCall('stat', path).catch((e) => { if (e.code === 'not-found') return null; throw e; });
        if (st?.size === sizes.get(path) + bytes.byteLength) { sizes.set(path, st.size); return false; }
      }
      const r = await fsCall(op, path, bytes.slice(0)); // the buffer is transferred; keep ours for a retry
      if (op === 'append' && typeof r.size === 'number') sizes.set(path, r.size);
      return true;
    } catch (e) {
      if (e.code !== 'io') throw e;
      maybeLanded = true;
      unsaved(path, at, e);
      await sleep(delay);
    }
  }
}

// ---- write-ahead log (IndexedDB) ----------------------------------------------------------------------------------------
// Every write / append is stored before it is sent and deleted once the host confirms it, so a reload, a crash or a
// closed tab (also mid-outage) loses at most nothing but what the browser itself drops; the next open of the package in
// this browser replays the rest. Own database: the iframe is same-origin with the admin and shares its IndexedDB. Records
// are keyed by bundle path + meeting.createdAt — two workspaces can hold the same relative path.
let walDb = null;
let walSeq = Date.now() * 1000; // increasing across page loads too, so a replayed record never sorts after a newer one
const walKey = () => `${bundlePath}|${meeting?.createdAt ?? ''}`;
function walOpen() {
  walDb ??= new Promise((res, rej) => {
    const req = indexedDB.open('htrans', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('chunks', { keyPath: ['key', 'path', 'seq'] }).createIndex('at', 'at');
      req.result.createObjectStore('sizes', { keyPath: ['key', 'path'] }).createIndex('at', 'at');
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return walDb;
}
/** One readwrite transaction over both stores; resolves with `fn`'s return value once it commits. Never throws: without
 *  IndexedDB recording still works, just without the reload safety net. */
async function walTx(fn) {
  try {
    const tx = (await walOpen()).transaction(['chunks', 'sizes'], 'readwrite');
    const out = fn(tx.objectStore('chunks'), tx.objectStore('sizes'));
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });
    return out;
  } catch (e) { console.warn('[htrans] wal', e); return null; }
}
/** `replace` = keep only this record for its path (meeting.json: only the latest copy matters). */
const walPut = (rec, replace) => walTx((c) => {
  if (replace) c.delete(IDBKeyRange.bound([rec.key, rec.path, 0], [rec.key, rec.path, rec.seq], false, true));
  c.put(rec);
});
const walDone = (rec) => walTx((c, s) => {
  c.delete([rec.key, rec.path, rec.seq]);
  if (rec.op === 'append' && sizes.has(rec.path)) s.put({ key: rec.key, path: rec.path, size: sizes.get(rec.path), at: Date.now() });
});
const walCleanup = () => walTx((...stores) => {
  for (const st of stores) {
    st.index('at').openCursor(IDBKeyRange.upperBound(Date.now() - 30 * 864e5)).onsuccess = (ev) => { const cur = ev.target.result; if (cur) { cur.delete(); cur.continue(); } };
  }
});
// The package's Web Lock is held for the iframe's lifetime by the page that got it on open, and queued for by a page
// that starts recording without it — so a page opened later never replays a live page's in-flight chunks.
let lockHeld = false;
const lockName = () => `htrans:${walKey()}`;
const hold = () => new Promise(() => {});
/** false = another tab / split pane has the package open (no replay, no crash recovery here — that page is alive), or no
 *  Web Locks (insecure context, which can't record either — the records stay for a later open). */
const holdLock = () => new Promise((res) => {
  if (!navigator.locks) return res(false);
  navigator.locks.request(lockName(), { ifAvailable: true }, (lock) => { res(!!lock); if (lock) { lockHeld = true; return hold(); } }).catch(() => res(false));
});
const queueLock = () => {
  if (lockHeld || !navigator.locks) return;
  lockHeld = true;
  navigator.locks.request(lockName(), hold).catch(() => {});
};

/** Queue a write / append of `data` (ArrayBuffer or Blob): logged, then sent in order behind everything earlier for `path`.
 *  The log entry is gone before the next send starts, so at most one entry per path can have landed unacknowledged. */
const persist = (path, op, data) => {
  const rec = { key: walKey(), path, seq: ++walSeq, op, at: Date.now() };
  const bytes = data instanceof Blob ? data.arrayBuffer() : Promise.resolve(data);
  const logged = bytes.then((b) => walPut({ ...rec, bytes: b }));
  return enqueue(path, async () => {
    await logged;
    try { await send(path, op, await bytes, rec.at); } finally { await walDone(rec); }
  });
};
const appendText = (path, s) => persist(path, 'append', enc(s));
const drainWrites = async () => { while (chains.size || meetingWrite) await Promise.all([...chains.values(), meetingWrite]); };

let meeting = null;
let meetingWrite = null; // in-flight promise; saves requested meanwhile coalesce into one follow-up write
let meetingAgain = false;
let meetingRec = null; // the latest meeting.json, already in the write-ahead log
const saveMeeting = () => {
  const bytes = enc(JSON.stringify(meeting, null, 2));
  meetingRec = { key: walKey(), path: 'meeting.json', seq: ++walSeq, op: 'write', at: Date.now(), bytes };
  meetingRec.logged = walPut({ ...meetingRec }, true);
  if (meetingWrite) { meetingAgain = true; return meetingWrite; }
  meetingWrite = (async () => {
    try {
      do {
        meetingAgain = false;
        const { logged, ...rec } = meetingRec;
        try { await logged; await send('meeting.json', 'write', rec.bytes, rec.at); } catch (e) { console.warn('[htrans] meeting.json', e); setNotice('fs', () => t('fsFail', e.message)); }
        await walDone(rec);
      } while (meetingAgain);
    } finally { meetingWrite = null; settled('meeting.json'); }
  })();
  return meetingWrite;
};

/** Write what an earlier page of this package in this browser left unconfirmed, in order per path, before the transcript
 *  is read and an interrupted run is closed (so its end counts the replayed lines). Only the head of each path can have
 *  landed unacknowledged — sends are serial — so only it gets the size check. */
async function replay() {
  const key = walKey(), range = IDBKeyRange.bound([key], [key, []]);
  const got = await walTx((c, s) => [c.getAll(range), s.getAll(range)]);
  const recs = got?.[0].result ?? [];
  if (!recs.length) return;
  for (const x of got[1].result) sizes.set(x.path, x.size);
  const byPath = new Map();
  for (const r of recs) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]); // key order = path, then seq
  const sent = [];
  await Promise.all([...byPath].map(([path, list]) => enqueue(path, async () => {
    for (const [i, r] of list.entries()) {
      try { if (await send(path, r.op, r.bytes, r.at, i === 0)) sent.push(r.at); }
      catch (e) {
        if (e.code === 'not-found') { for (const x of list.slice(i)) await walDone(x); return; } // package deleted / renamed meanwhile
        console.warn('[htrans] replay', path, e); setNotice('fs', () => t('fsFail', e.message));
      }
      await walDone(r);
    }
  })));
  const m = byPath.get('meeting.json')?.at(-1);
  if (m) { meeting = JSON.parse(new TextDecoder().decode(m.bytes)); if (!Array.isArray(meeting.runs)) meeting.runs = []; }
  const min = Math.max(1, Math.round((Math.max(...sent) - Math.min(...sent)) / 60000));
  if (sent.length) setNotice('restored', () => t('restored', min));
}

// ---- notices / status ---------------------------------------------------------------------------------------------------

const notices = new Map();
/** `msg` is a () => string (or null to clear), so a host language switch re-renders it — see applyLang. */
function setNotice(key, msg, kind = 'warn') {
  if (msg) notices.set(key, { msg, kind }); else notices.delete(key);
  renderNotices();
}
function renderNotices() {
  const box = $('notice');
  box.replaceChildren(...[...notices.values()].map((n) => el('div', null, n.msg())));
  box.className = 'notice' + ([...notices.values()].some((n) => n.kind === 'err') ? ' err' : '');
  box.hidden = notices.size === 0;
}
let toastTimer = 0;
function toast(msg) { const n = $('toast'); n.textContent = msg; n.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { n.hidden = true; }, 1600); }

// ---- state ------------------------------------------------------------------------------------------------------------------

let bundlePath = '';
let title = '';
let phase = 'idle'; // idle | starting | recording | stopping | stopped
let rec = null; // the active run (runtime objects), null when not recording
const tx = { ws: null, state: 'off', ready: false, startWall: 0, partialAt: 0, partialSeen: 0, failures: 0, backoff: 1000, retryAt: 0, readyAt: 0, err: null, closing: false, onClosed: null };

const setPhase = (p) => { phase = p; renderControls(); };

function renderControls() {
  const running = phase === 'recording';
  const idle = phase === 'idle' || phase === 'stopped';
  const hasRuns = (meeting?.runs.length ?? 0) > 0;
  // One toggle: Start (nothing recorded yet) / Pause (recording) / Resume. A pause ends the run, Resume starts a new one.
  const tg = $('toggle'), pausing = running || phase === 'stopping';
  tg.textContent = pausing ? t('pause') : meeting?.runs.some((r) => r.endedAt) ? t('resume') : t('start');
  tg.className = 'toggle' + (pausing ? ' danger' : ' primary');
  tg.disabled = running ? false : !idle || !meeting || !navigator.mediaDevices;
  for (const id of ['mic', 'micRefresh', 'sys', 'shot', 'lang', 'speakers']) $(id).disabled = !idle;
  showEmpty(entryCount === 0 && idle);
  const label = phase === 'recording' ? 'sRec' : phase === 'starting' || phase === 'stopping' ? 'sBusy' : hasRuns || phase === 'stopped' ? 'sStopped' : 'sReady';
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
    if (tx.state === 'connecting') { txt = t('txConnecting'); cls += ' wait'; }
    else if (tx.state === 'live') { txt = t('txLive'); cls += ' live'; }
    else if (tx.state === 'reconnecting') { txt = `${t('txRetry')}… ${wait ? t('retryIn', wait) : ''}`; cls += ' wait'; }
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
// Each thumbnail is a fixed-ratio placeholder box (data-state '' | loading | loaded | error) whose <img> stays invisible
// until it has really decoded, so a missing / unloaded / broken source never shows the browser's broken-image icon.
let shotAspect = '16 / 9'; // last known screenshot ratio (one share per meeting, usually), until a box knows its own
async function loadShot(box) {
  if (box.dataset.state) return;
  box.dataset.state = 'loading';
  const img = box.firstChild;
  let r;
  try { await chains.get(box.dataset.shot); r = await fsCall('read', box.dataset.shot); } catch { if (box.dataset.state === 'loading') box.dataset.state = 'error'; return; } // its write may still be queued / retrying
  if (box.dataset.state !== 'loading' || img.src) return; // unloaded meanwhile, or an earlier read already set it
  img.onload = () => { if (box.dataset.state === 'loading') { box.style.aspectRatio = shotAspect = `${img.naturalWidth} / ${img.naturalHeight}`; box.dataset.state = 'loaded'; } };
  img.onerror = () => { if (img.src) { unloadShot(box); box.dataset.state = 'error'; } };
  img.src = URL.createObjectURL(new Blob([r.buffer], { type: 'image/jpeg' }));
}
function unloadShot(box) {
  const img = box.firstChild;
  box.dataset.state = ''; // back to the placeholder (an error retries next time it scrolls into view)
  if (img.src) { URL.revokeObjectURL(img.src); img.removeAttribute('src'); }
}

function addEntry(e) {
  entryCount++;
  showEmpty(false);
  const row = el('div', e.shot ? 'line shot' : 'line');
  row.append(el('span', 'ts', `[${fmt(e.t)}]`));
  if (e.shot) {
    const box = el('div', 'thumb'), img = el('img');
    box.dataset.shot = e.shot;
    box.dataset.ts = fmt(e.t);
    box.dataset.msg = t('shotFail');
    box.style.aspectRatio = shotAspect;
    img.alt = t('shotAlt', box.dataset.ts);
    box.onclick = () => { if (box.dataset.state === 'loaded') openLightbox(img); };
    box.append(img);
    row.append(box);
    io.observe(box);
  } else {
    if (e.speaker) {
      const spk = el('span', 'spk', t('speaker', e.speaker));
      spk.dataset.n = e.speaker;
      spk.dataset.c = (e.speaker - 1) % 6; // style.css palette --spk-0…5
      row.append(spk);
    }
    row.append(el('span', 'tx', e.text));
  }
  log.insertBefore(row, partialEl);
  maybeScroll();
}
// Lightbox: same rule — the big <img> only shows once loaded; until then a placeholder, on failure a message.
const lightbox = $('lightbox'), bigImg = lightbox.querySelector('img');
bigImg.onload = () => { if (!lightbox.hidden) lightbox.dataset.state = 'loaded'; };
bigImg.onerror = () => { if (bigImg.src) lightbox.dataset.state = 'error'; };
function openLightbox(img) {
  lightbox.dataset.state = 'loading';
  bigImg.alt = img.alt;
  bigImg.src = img.src;
  lightbox.hidden = false;
}
function closeLightbox() {
  lightbox.hidden = true;
  lightbox.dataset.state = '';
  bigImg.removeAttribute('src'); // the thumbnail may revoke its blob URL; the next open sets src afresh
}
lightbox.onclick = closeLightbox;
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !lightbox.hidden) { e.preventDefault(); closeLightbox(); } });

// ---- package lifecycle ------------------------------------------------------------------------------------------------------

const README = `# Meeting package · 会议记录包 (htrans)

Recorded by the Halo "Meeting Recorder" extension. 由 Halo「Meeting Recorder」扩展录制。

| File / 文件 | What it is / 说明 |
|---|---|
| \`transcript.md\` | **Read this. / 请读这个。** Timeline \`[HH:MM:SS] text\` (\`[HH:MM:SS] Speaker N: text\` when "Identify speakers" was on) and screenshot lines \`[HH:MM:SS] 📷 shots/NNNNNN.jpg\`. Offsets count from \`meeting.json\`.startedAt. 时间线，偏移量从 startedAt 起算；勾选「区分说话人」时带 \`Speaker N:\` 说话人编号。 |
| \`transcript.jsonl\` | Same content, one JSON per line: \`{"t","end","at","text","lang","speaker"?}\` or \`{"t","at","shot"}\` (\`t\`/\`end\` = ms since startedAt, \`at\` = epoch ms, \`speaker\` = 1, 2, …). 同样内容，机器可读；\`speaker\` 为说话人编号（可选）。 |
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
- \`Speaker N\` / \`speaker\` only tells voices apart — it is a number, not a name, and nobody is identified. Numbers hold within one transcription stream only: after a pause / resume or a reconnect the same person may get a different number. Speakers are only labelled when "Identify speakers" was ticked (\`meeting.json\` → \`asr.speakers\`); it is off by default, so most lines have no speaker.
  \`Speaker N\` / \`speaker\` 只用来区分不同的声音，是编号不是姓名，不识别具体是谁。编号只在一条转写流内有效：暂停后继续、断线重连之后，同一个人可能换编号。只有勾选「区分说话人」时才标说话人（\`meeting.json\` 的 \`asr.speakers\`），默认不勾，所以多数行没有说话人。
- Write your own notes to \`notes.md\`; leave the other files untouched (the recorder is still appending to them while recording).
  请把笔记写到 \`notes.md\`，不要改动其他文件（录制中会继续追加）。
`;

async function loadPackage() {
  let raw = null;
  try { raw = new Uint8Array((await fsCall('read', 'meeting.json')).buffer); } catch (e) { if (e.code !== 'not-found') { setNotice('pkg', () => t('pkgBad', e.message), 'err'); renderControls(); return; } }
  if (!raw) {
    meeting = { format: 'htrans', version: 1, title, createdAt: new Date().toISOString(), status: 'idle', runs: [], shotIntervalSec: 0, asr: { engine: 'aws-transcribe', language: DEFAULT_LANG } };
    await Promise.all([saveMeeting(), persist('README.md', 'write', enc(README))]);
  } else {
    try { meeting = JSON.parse(new TextDecoder().decode(raw)); if (!Array.isArray(meeting.runs)) meeting.runs = []; } catch (e) { setNotice('pkg', () => t('pkgBad', e.message), 'err'); renderControls(); return; }
  }
  await walCleanup();
  const owner = await holdLock();
  if (owner) await replay();
  let entries = [];
  try {
    const text = new TextDecoder().decode((await fsCall('read', 'transcript.jsonl')).buffer);
    for (const line of text.split('\n')) { if (!line.trim()) continue; try { entries.push(JSON.parse(line)); } catch { /* torn last line after a crash */ } }
  } catch (e) { if (e.code !== 'not-found') setNotice('pkg', () => t('pkgBad', e.message), 'err'); }
  // A previous session died while recording (crash / reload): close its run off the last thing it managed to write.
  // Not while another page holds the package's lock: that one is alive (maybe still recording).
  if (meeting.status === 'recording' && (owner || !navigator.locks)) {
    const run = meeting.runs[meeting.runs.length - 1];
    if (run && !run.endedAt) {
      const last = entries.reduce((m, e) => Math.max(m, e.at != null ? e.at + (e.end != null && e.t != null ? e.end - e.t : 0) : 0), 0);
      run.interrupted = true;
      run.endedAt = Math.max(run.startedAt, last || Date.now());
    }
    meeting.status = 'stopped';
    saveMeeting(); // not awaited: a write being retried must not keep the package from opening
  }
  $('shot').value = String(meeting.shotIntervalSec ?? 0);
  if (meeting.asr?.language) $('lang').value = meeting.asr.language;
  if (!$('lang').value) $('lang').value = DEFAULT_LANG;
  $('speakers').checked = meeting.asr?.speakers === true; // off for new meetings and packages from <= 1.0.7
  entries.sort((a, b) => (a.t ?? 0) - (b.t ?? 0)); // stable; packages from <= 1.0.2 may have shots before earlier speech
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
    shotAspect = `${c.width} / ${c.height}`;
    const at = Date.now();
    const off = at - meeting.startedAt;
    const path = `shots/${pad(Math.floor(off / 1000), 6)}.jpg`;
    const buf = await blob.arrayBuffer();
    persist(path, 'write', buf); // not awaited: a write being retried must not hold r.shotBusy (endRun waits on it)
    heldShots.push({ t: off, at, shot: path });
    releaseShots(watermark());
  } finally { frame.done(); }
}

// Timeline order: a final is stamped with its sentence's *start* but only arrives once the sentence ends, so a
// screenshot taken mid-sentence would land before that sentence. Its timeline line (not the image file) is held until
// no earlier speech can still arrive.
const heldShots = [];
function writeEntry(e) {
  appendText('transcript.md', `[${fmt(e.t)}] ${e.shot ? `📷 ${e.shot}` : e.speaker ? `Speaker ${e.speaker}: ${e.text}` : e.text}\n`);
  appendText('transcript.jsonl', JSON.stringify(e) + '\n');
  addEntry(e);
}
/** Wall-clock ms before which every sentence is final: no stream -> everything; a partial in progress -> its start;
 *  otherwise speech that began over ~2 s ago would already show as a partial. A partial silent for 10 s is treated as
 *  dropped (the proxy skips empty finals), so a long quiet stretch doesn't hold screenshots indefinitely. */
const watermark = () => {
  const now = Date.now();
  if (!tx.ws) return Infinity;
  return tx.partialAt && now - tx.partialSeen < 10000 ? tx.partialAt : now - 2000;
};
function releaseShots(before) {
  while (heldShots.length && heldShots[0].at < before) writeEntry(heldShots.shift());
}

// ---- transcription (WS proxy) ---------------------------------------------------------------------------------------------

function txOpen() {
  const lang = TX_LANG[$('lang').value] ?? $('lang').value;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/transcribe/stream?ext=htrans&lang=${encodeURIComponent(lang)}${$('speakers').checked ? '&speakers=1' : ''}`);
  ws.binaryType = 'arraybuffer';
  Object.assign(tx, { ws, state: 'connecting', ready: false, startWall: 0, partialAt: 0, err: null, closing: false, retryAt: 0 });
  ws.onmessage = (ev) => {
    if (tx.ws !== ws || typeof ev.data !== 'string') return;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'ready') { tx.ready = true; tx.state = 'live'; tx.readyAt = Date.now(); tx.failures = 0; setNotice('tx', null); }
    else if (m.type === 'partial') {
      partialEl.textContent = m.text || '';
      tx.partialAt = tx.startWall ? Math.round(tx.startWall + m.start * 1000) : 0;
      tx.partialSeen = Date.now();
      releaseShots(watermark());
    }
    else if (m.type === 'final') onFinal(m);
    else if (m.type === 'error') tx.err = m;
    renderTicker(true);
  };
  const closed = () => {
    if (tx.ws !== ws) return;
    const livedMs = tx.ready ? Date.now() - tx.readyAt : 0;
    const wasReady = tx.ready;
    Object.assign(tx, { ws: null, ready: false, startWall: 0, partialAt: 0 });
    partialEl.textContent = '';
    releaseShots(Infinity); // the partial in progress (if any) will never finalize
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
    if (code === 'credentials' || code === 'denied' || code === 'limit') setNotice('tx', () => t(code), 'err');
    else if (code) { const msg = tx.err.message || code; setNotice('tx', () => msg, 'err'); }
    else if (tx.failures >= 2) setNotice('tx', () => t('unreachable'), 'err');
    tx.retryAt = Date.now() + delay;
    renderTicker(true);
  };
  ws.onclose = closed;
  ws.onerror = () => { /* onclose always follows */ };
}

function onFinal(m) {
  const text = (m.text || '').trim();
  partialEl.textContent = '';
  tx.partialAt = 0;
  if (!text || !tx.startWall) return;
  const at = Math.round(tx.startWall + m.start * 1000);
  const off = at - meeting.startedAt;
  releaseShots(at);
  const speaker = m.speaker == null ? NaN : Number(m.speaker) + 1; // Transcribe's "0", "1"… → Speaker 1, 2…; older proxies send none
  writeEntry({ t: off, end: Math.round(tx.startWall + m.end * 1000 - meeting.startedAt), at, text, lang: m.lang || $('lang').value, ...(speaker > 0 ? { speaker } : {}) });
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
  if (phase !== 'idle' && phase !== 'stopped') return;
  const wantMic = $('mic').value !== 'none';
  const wantSys = caps.sys && $('sys').checked;
  const shotSec = caps.shot ? Number($('shot').value) : 0; // hidden row may still hold a saved meeting.json interval
  if (!wantMic && !wantSys && !shotSec) { setNotice('start', () => t('noSource')); return; }
  setNotice('start', null); setNotice('fs', null); setNotice('restored', null); // 'save' (unsaved data) stays until it is written
  setPhase('starting');
  let display = null, micStream = null, ctx = null;
  try {
    // getDisplayMedia needs the click's user activation, so it goes first (the mic prompt can take longer than it lasts).
    if (wantSys || shotSec) {
      try { display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: wantSys }); }
      catch { setNotice('start', () => t('shareCancelled')); setPhase(meeting.runs.length ? 'stopped' : 'idle'); return; }
      if (!shotSec) display.getVideoTracks().forEach((tr) => tr.stop()); // only the sound is wanted
    }
    const sysTracks = wantSys && display ? display.getAudioTracks() : [];
    if (wantSys && !sysTracks.length) setNotice('sys', () => t('noSysAudio'));
    else setNotice('sys', null);
    if (wantMic) {
      const id = $('mic').value;
      try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { ...(id ? { deviceId: { exact: id } } : {}), echoCancellation: true, noiseSuppression: true } }); }
      catch (e) { stopTracks(display); setNotice('start', () => t('micFailed', e.message || e.name)); setPhase(meeting.runs.length ? 'stopped' : 'idle'); return; }
      refreshDevices(); // labels are available now
    }
    const hasAudio = !!micStream || sysTracks.length > 0;
    if (!hasAudio && !(shotSec && display?.getVideoTracks().length)) { stopTracks(display); setNotice('start', () => t('noSource')); setPhase(meeting.runs.length ? 'stopped' : 'idle'); return; }

    queueLock();
    const now = Date.now();
    meeting.startedAt ??= now;
    const idx = meeting.runs.length + 1;
    const audio = hasAudio ? `audio/${pad(idx, 3)}.webm` : undefined;
    const run = { startedAt: now, ...(audio ? { audio } : {}), sources: [...(micStream ? ['mic'] : []), ...(sysTracks.length ? ['system'] : []), ...(shotSec && display ? ['screen'] : [])] };
    meeting.runs.push(run);
    meeting.status = 'recording';
    meeting.shotIntervalSec = shotSec;
    meeting.asr = { engine: 'aws-transcribe', language: $('lang').value, speakers: $('speakers').checked };
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
        mr.ondataavailable = (ev) => { if (ev.data.size) persist(audio, 'append', ev.data); };
        r.recorderStopped = new Promise((res) => { mr.onstop = res; });
        mr.start(5000);
      } else setNotice('rec', () => t('noRecorder'));
    }
    micStream?.getAudioTracks()[0]?.addEventListener('ended', () => setNotice('end-mic', () => t('micEnded')));
    display?.getVideoTracks()[0]?.addEventListener('ended', () => { r.nextShotAt = 0; setNotice('end-share', () => t('shareEnded')); });
    r.tickTimer = setInterval(tick, 1000);
    sysTracks[0]?.addEventListener('ended', () => setNotice('end-share', () => t('shareEnded')));
    Object.assign(tx, { backoff: 1000, failures: 0 });
    if (hasAudio) txOpen();
    post({ type: 'dirty', dirty: true });
    setPhase('recording');
    renderTicker(true);
    await saveMeeting();
  } catch (e) {
    console.warn('[htrans] start failed', e);
    setNotice('start', () => t('micFailed', e.message || String(e)), 'err');
    if (rec) await endRun(); else { stopTracks(display, micStream); ctx?.close(); setPhase(meeting.runs.length ? 'stopped' : 'idle'); }
  }
}

async function endRun() {
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
  releaseShots(Infinity); // txFinish's timeout path closes the socket without the onclose release
  rec = null;
  r.node?.port.close();
  stopTracks(r.micStream, r.display);
  r.video?.remove();
  r.ctx?.close().catch(() => {});
  partialEl.textContent = '';
  r.run.endedAt = Date.now();
  meeting.status = 'stopped';
  setNotice('tx', null);
  saveMeeting();
  // Writes still being retried don't hold the controls (a new run queues behind them); the host keeps its unsaved-changes
  // guard until they have all landed, and a run started meanwhile clears it itself when it ends.
  setPhase('stopped');
  renderTicker(true);
  await drainWrites();
  if (!rec) post({ type: 'dirty', dirty: false });
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
  if (heldShots.length) releaseShots(watermark());
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

// What this engine can really capture, feature-detected once (no permission prompt). getDisplayMedia missing = mobile;
// the iframe's permissions policy can withhold display-capture (an API-less policy = Firefox / Safari = allowed).
// suppressLocalAudioPlayback only applies to a share's audio track, so only engines that capture shared audio expose
// it (Chrome / Edge 109+, Electron; not Firefox / Safari / iOS). Screenshots need capture only (the <video> path).
const md = navigator.mediaDevices;
const policy = document.permissionsPolicy ?? document.featurePolicy;
const canCapture = typeof md?.getDisplayMedia === 'function' && (policy?.allowsFeature?.('display-capture') ?? true);
const caps = { shot: canCapture, sys: canCapture && md.getSupportedConstraints?.().suppressLocalAudioPlayback === true };
window.__htransCaps = caps;
document.documentElement.dataset.capSys = String(caps.sys);
document.documentElement.dataset.capShot = String(caps.shot);
// No mediaDevices at all is the insecure-context case: the `noMedia` notice explains it, don't blame the browser here.
$('srcSys').hidden = !!md && !caps.sys;
$('srcShot').hidden = !!md && !caps.shot;

// Host theme tokens -> --halo-<token> (style.css derives its palette from them, falling back to built-in values).
let themeKeys = [];
function applyTheme(m) {
  const root = document.documentElement;
  root.dataset.theme = m.theme;
  const vars = m.themeVars && typeof m.themeVars === 'object' ? m.themeVars : {};
  const keys = Object.keys(vars).filter((k) => /^[a-z-]+$/.test(k) && typeof vars[k] === 'string');
  for (const k of themeKeys) if (!keys.includes(k)) root.style.removeProperty(`--halo-${k}`);
  for (const k of keys) root.style.setProperty(`--halo-${k}`, vars[k]);
  themeKeys = keys;
}

function applyLang() {
  document.documentElement.lang = lang;
  for (const n of document.querySelectorAll('[data-i]')) n.textContent = t(n.dataset.i);
  if (title) document.title = `${title} · ${t('appName')}`;
  $('copyPrompt').title = $('copyPrompt').ariaLabel = t('copy');
  $('micRefresh').title = $('micRefresh').ariaLabel = t('refresh');
  $('elapsed').title = t('elapsed');
  $('sys').closest('label').title = t('sysTip');
  const capKey = !md || caps.sys ? '' : caps.shot ? 'capNoSys' : 'capNone';
  $('capNote').textContent = capKey ? t(capKey) : '';
  $('capNote').hidden = !capKey;
  $('lightbox').title = t('closeHint');
  $('lightbox').dataset.msg = t('shotFail');
  for (const box of log.querySelectorAll('.thumb')) { box.firstChild.alt = t('shotAlt', box.dataset.ts); box.dataset.msg = t('shotFail'); }
  for (const spk of log.querySelectorAll('.spk')) spk.textContent = t('speaker', spk.dataset.n);
  renderNotices();
  $('jump').textContent = t('jump');
  const sel = $('shot'), cur = sel.value || '0';
  sel.replaceChildren(...SHOTS.map((s) => new Option(s ? `${s} ${t('secs')}` : t('off'), String(s))));
  sel.value = cur;
  const ls = $('lang'), lcur = ls.value || DEFAULT_LANG;
  ls.replaceChildren(...LANGS.map((v) => new Option(t('langs')[v], v)));
  ls.value = LANGS.includes(lcur) ? lcur : DEFAULT_LANG;
  $('langHelp').title = $('langHelp').ariaLabel = t('langHelp');
  $('langTip').replaceChildren(...t('langTip').map((x) => Object.assign(document.createElement('li'), { textContent: x })));
  partialEl.dataset.ph = t('speaking');
  if (emptyEl) emptyEl.textContent = t('empty');
  renderControls();
}

$('toggle').onclick = () => (phase === 'recording' ? endRun() : start());
$('micRefresh').onclick = refreshDevices;
$('langHelp').onclick = () => { const tip = $('langTip'); tip.hidden = !tip.hidden; $('langHelp').ariaExpanded = String(!tip.hidden); };
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
    else p.reject(Object.assign(new Error(m.error), { code: m.code, auth: m.auth === true })); // auth: login expired (newer hosts)
  } else if (m.type === 'theme') applyTheme(m);
  else if (m.type === 'lang') {
    lang = m.lang === 'en' ? 'en' : 'zh';
    applyLang(); // also renderControls; select values are restored, a running recording is untouched
    renderTicker(true);
    if (md) refreshDevices(); // relabel "Default microphone" etc., keeps the selection
  } else if (m.type === 'init') {
    applyTheme(m);
    lang = m.lang === 'en' ? 'en' : 'zh';
    bundlePath = m.file.path;
    title = m.file.name.replace(/\.htrans$/i, '');
    $('title').textContent = title;
    $('title').title = title;
    applyLang();
    if (!navigator.mediaDevices) { setNotice('media', () => t('noMedia'), 'err'); }
    else { refreshDevices(); navigator.mediaDevices.addEventListener?.('devicechange', refreshDevices); }
    loadPackage();
  }
});

post({ type: 'ready', protocol: 1 });
