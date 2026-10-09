'use strict';
// Halo canvas extension "megadrive": Sega Mega Drive / Genesis (+ Master System / Game Gear) on EmulatorJS 4.2.3 with
// the Genesis Plus GX core, fully offline. Opens a `.mega` bundle (a directory) holding game.json — which ROM, which
// display filter — and saves/<rom>.state. The ROM stays wherever it is on the machine: picked with the host's file
// picker and read in place every time (capability fs-read; `fs` scope 'workspace' for a ROM in the workspace,
// 'system' for an absolute path outside it); nothing but game.json and saves/ is ever written into the bundle.
// Halo protocol v1: ready → init (bundle) → fs / pick; theme / lang live.
//
// EmulatorJS owns the core, archive extraction, canvas, audio and the touch buttons. Keyboard, physical gamepad, the
// touch stick, pause and save states are ours (EmulatorJS's input handlers are switched off in boot()): EmulatorJS
// binds one key or pad button per control, so it can't drive a direction from both the d-pad and the left stick, and
// it has no pause button; one layer owning every binding also keeps the help panel truthful.
(() => {
  const $ = (id) => document.getElementById(id);
  const post = (m, transfer = []) => parent.postMessage({ haloExt: 1, ...m }, '*', transfer);
  const LS = 'halo-ext-megadrive:'; // the iframe shares the admin's origin, so its localStorage too

  // ── text ──────────────────────────────────────────────────────────────
  const T = {
    zh: {
      help: '⌨ 按键', pause: '⏸ 暂停', resume: '▶ 继续', save: '💾 存档', load: '📂 读档', full: '⛶ 全屏', pick: '📁 换一个 ROM',
      touch: (m) => `🕹 虚拟手柄：${{ auto: '自动', on: '开', off: '关' }[m]}`,
      display: '画面', shader: { pixel: '像素', soft: '柔化', hd: '高清', crt: 'CRT' },
      reading: '正在读取 ROM…', choose: '选择 ROM', repick: '换一个 ROM',
      accepts: '支持 .zip / .7z（里面是 MD ROM）和 .md .gen .smd .bin .sms .gg。ROM 留在原处，这里只记下它的位置。',
      startGame: (n) => `▶ 开始 · ${n}`, startKeys: '或按 Enter',
      missing: '找不到 ROM', missingText: (p) => `game.json 里记的是「${p}」，那里没有这个文件（可能被移动、改名或删除了）。`, readFail: (e) => `读取失败：${e}`,
      noRom: '压缩包里没有 MD ROM（支持 .md .gen .smd .bin .sms .gg）', notArchive: '这个文件解不开（压缩包可能已损坏）。',
      entries: (n) => `压缩包内容（${n} 项）`, more: (n) => `…还有 ${n} 项`,
      padOn: (n) => `🎮 已连接：${n}`, padOff: '未检测到手柄 — 连接后按任意键唤醒', padInsecure: '手柄需要 HTTPS 或 localhost 访问',
      pausedBlur: '已暂停 — 点击画面继续', pausedUser: '已暂停 — 按 P（手柄 LB）或点击画面继续',
      saved: '已存档（F4 读档）', loaded: '已读档', noSave: '还没有存档 — 先按 F2', saveFail: '存档失败', loadFail: '读档失败',
      fsFail: (e) => `写入失败：${e}`, pickFail: (e) => `打不开文件选择：${e}`,
      kb: '键盘（1P）', gp: '手柄', act: '动作',
      dir: '方向', btn: (n) => `按键 ${n}`,
      startK: '开始', coin: '投币 / Mode', coinMS: '投币（无作用）', pauseK: '暂停 / 继续', qsave: '快速存档', qload: '快速读档', mute: '静音', fullK: '全屏',
      dpad: '十字键 / 左摇杆', fullHow: '工具栏按钮 / 双击画面', none: '—',
      notes: [
        '快速存档（F2 / F4）保存在这个 .mega 目录的 saves/ 里，跟着工作区走；游戏内的电池存档仍只在本浏览器里。',
        'ROM 不会复制进这个目录，game.json 只记下它的位置（在工作区里记相对位置，在工作区外记绝对路径）；ROM 挪了地方就点「换一个 ROM」重新选。',
        '在 Halo 里放大画布时，Esc 用于退出放大。',
        '触屏设备上：左半屏任意位置按下就出现摇杆（八个方向），右边是动作按钮；用了键盘或手柄就自动隐藏，再摸一下屏幕又会出现。工具栏「虚拟手柄」可切换 自动 / 开 / 关。',
        '蓝牙手柄连上后要先按一下任意键，浏览器才会识别。',
      ],
      lic: 'EmulatorJS 4.2.3（GPL-3.0）+ Genesis Plus GX（仅限非商业用途）· 不含任何游戏 ROM',
      vStart: '开始', vCoin: '投币', vPause: '暂停',
    },
    en: {
      help: '⌨ Keys', pause: '⏸ Pause', resume: '▶ Resume', save: '💾 Save', load: '📂 Load', full: '⛶ Fullscreen', pick: '📁 Change ROM',
      touch: (m) => `🕹 Touch controls: ${{ auto: 'Auto', on: 'On', off: 'Off' }[m]}`,
      display: 'Display', shader: { pixel: 'Pixel', soft: 'Soft', hd: 'HD', crt: 'CRT' },
      reading: 'Reading the ROM…', choose: 'Choose ROM', repick: 'Change ROM',
      accepts: 'Accepts .zip / .7z (holding a Mega Drive ROM) and .md .gen .smd .bin .sms .gg. The ROM stays where it is; only its location is stored here.',
      startGame: (n) => `▶ Start · ${n}`, startKeys: 'or press Enter',
      missing: 'ROM not found', missingText: (p) => `game.json points to “${p}”, but there is no file there (moved, renamed or deleted?).`, readFail: (e) => `Could not read it: ${e}`,
      noRom: 'No Mega Drive ROM in this archive (supported: .md .gen .smd .bin .sms .gg)', notArchive: 'This file could not be unpacked (the archive may be damaged).',
      entries: (n) => `Archive contents (${n})`, more: (n) => `…${n} more`,
      padOn: (n) => `🎮 Connected: ${n}`, padOff: 'No gamepad — press any button on it to wake it', padInsecure: 'Gamepads need HTTPS or localhost',
      pausedBlur: 'Paused — click the game to continue', pausedUser: 'Paused — press P (pad LB) or click the game to continue',
      saved: 'State saved (F4 to load)', loaded: 'State loaded', noSave: 'No saved state yet — press F2 first', saveFail: 'Save failed', loadFail: 'Load failed',
      fsFail: (e) => `Could not write: ${e}`, pickFail: (e) => `Could not open the file picker: ${e}`,
      kb: 'Keyboard (1P)', gp: 'Gamepad', act: 'Action',
      dir: 'Move', btn: (n) => `Button ${n}`,
      startK: 'Start', coin: 'Coin / Mode', coinMS: 'Coin (unused)', pauseK: 'Pause / resume', qsave: 'Quick save', qload: 'Quick load', mute: 'Mute', fullK: 'Fullscreen',
      dpad: 'D-pad / left stick', fullHow: 'toolbar button / double-click the game', none: '—',
      notes: [
        'Quick saves (F2 / F4) go to saves/ inside this .mega folder and travel with the workspace; in-game battery saves stay in this browser.',
        'The ROM is never copied into this folder — game.json only stores where it is (relative to this folder inside the workspace, an absolute path outside it). If you move the ROM, pick it again with “Change ROM”.',
        'When the Halo canvas is maximized, Esc exits the maximized view.',
        'Touch screens: press anywhere in the left half for a stick (8 directions); the action buttons are on the right. They hide when you use a keyboard or gamepad and come back on the next touch. The “Touch controls” toolbar button cycles Auto / On / Off.',
        'A Bluetooth gamepad shows up only after you press one of its buttons.',
      ],
      lic: 'EmulatorJS 4.2.3 (GPL-3.0) + Genesis Plus GX (non-commercial use only) · no game ROMs included',
      vStart: 'Start', vCoin: 'Coin', vPause: 'Pause',
    },
  };
  let lang = 'zh';
  const t = (k, ...a) => { const v = T[lang][k] ?? T.en[k]; return typeof v === 'function' ? v(...a) : v; };

  // ── systems / formats ─────────────────────────────────────────────────
  // EmulatorJS picks the core from `system`: segaMD / segaGG resolve to genesis_plus_gx, but segaMS would resolve to
  // smsplus (not bundled), so SMS passes the core name itself (its control scheme then resolves to segaMS).
  const SYS = {
    md: { core: 'segaMD', name: 'Sega Genesis / Mega Drive', six: true },
    sms: { core: 'genesis_plus_gx', name: 'Sega Master System', six: false },
    gg: { core: 'segaGG', name: 'Sega Game Gear', six: false },
  };
  const EXT_SYS = { md: 'md', gen: 'md', smd: 'md', bin: 'md', sms: 'sms', gg: 'gg' };
  const ACCEPT = ['.zip', '.7z', '.md', '.gen', '.smd', '.bin', '.sms', '.gg'];
  const extOf = (n) => (n.match(/\.([^./]+)$/)?.[1] ?? '').toLowerCase();
  const baseOf = (p) => p.replace(/^.*\//, '');
  const stem = (p) => baseOf(p).replace(/\.[^.]+$/, '');

  // Archives go through EmulatorJS's own extractors (compression/extract{zip,7z}.js, emscripten workers): one worker
  // per archive, each entry comes back as {t:2, file, data}, then {t:1} = done. Detected by magic bytes, not by name.
  const MAGIC = { zip: [0x50, 0x4b], '7z': [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] };
  const archiveKind = (u8) => Object.keys(MAGIC).find((k) => MAGIC[k].every((b, i) => u8[i] === b)) ?? null;
  async function extract(buf, kind) {
    const src = await (await fetch(`emulatorjs/compression/extract${kind}.js`)).text();
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    return new Promise((resolve, reject) => {
      const w = new Worker(url), files = [];
      const done = (fn, v) => { w.terminate(); URL.revokeObjectURL(url); fn(v); };
      w.onmessage = (e) => {
        if (e.data?.t === 2 && !e.data.file.endsWith('/')) files.push({ name: e.data.file, data: e.data.data });
        else if (e.data?.t === 1) done(resolve, files);
      };
      w.onerror = (e) => { e.preventDefault(); done(reject, new Error(e.message || 'archive error')); };
      w.postMessage(new Uint8Array(buf));
    });
  }
  /** The ROM inside an archive: the first .md / .gen / .smd / .sms / .gg, else the archive's only .bin if it is at
   *  least 128 KiB — the smallest Mega Drive cartridge (plenty of archives carry small unrelated .bin files). */
  function romIn(files) {
    const hit = files.find((f) => EXT_SYS[extOf(f.name)] && extOf(f.name) !== 'bin');
    if (hit) return hit;
    const bins = files.filter((f) => extOf(f.name) === 'bin');
    return bins.length === 1 && bins[0].data.length >= 128 * 1024 ? bins[0] : null;
  }

  // ── host fs / pick ────────────────────────────────────────────────────
  let reqSeq = 0;
  const pending = new Map(); // id → {resolve, reject}; fs-result and pick-result share the id space
  const request = (frame, transfer) => new Promise((resolve, reject) => {
    const id = ++reqSeq;
    pending.set(id, { resolve, reject });
    post({ ...frame, id }, transfer);
  });
  const fsCall = (op, path, extra = {}) => request({ type: 'fs', op, path, ...extra }, extra.buffer ? [extra.buffer] : []);
  const enc = (s) => new TextEncoder().encode(s).buffer;

  /** Absolute = outside the workspace: POSIX `/…` or Windows `C:/…` (the host always sends forward slashes). */
  const isAbs = (p) => p.startsWith('/') || /^[A-Za-z]:\//.test(p);
  /** game.json `rom` → where to read it: an absolute path as-is with scope 'system'; else POSIX relative to the
   *  bundle dir (may climb with ../) → a workspace path, scope 'workspace'. null if empty or above the root. */
  function resolveRom(dir, rel) {
    if (typeof rel !== 'string' || !rel) return null;
    if (isAbs(rel)) return { path: rel, scope: 'system' };
    const out = dir.split('/').filter(Boolean);
    for (const seg of rel.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg !== '..') out.push(seg);
      else if (!out.length) return null;
      else out.pop();
    }
    return out.length ? { path: out.join('/'), scope: 'workspace' } : null;
  }
  /** workspace path → relative to the bundle dir (inside it: "sf2.zip"; elsewhere: "../roms/sf2.zip"). */
  function relFromBundle(dir, target) {
    const a = dir.split('/').filter(Boolean), b = target.split('/');
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
  }

  // ── display filter ────────────────────────────────────────────────────
  // game.json.shader → EmulatorJS shader preset (data/src/shaders.js: libretro GLSL ports, all GLSL ES 1.0, so they
  // run on the WebGL 1 "-legacy" core build this page loads). Applied live through EmulatorJS's own "shader" setting.
  // Default (new bundle, or game.json without a shader) = crt. A shader game.json already names is kept.
  const SHADERS = { pixel: null, soft: 'bicubic', hd: 'sabr', crt: 'crt-easymode.glslp' };
  const shaderKey = () => (Object.hasOwn(SHADERS, game.shader) ? game.shader : 'crt');
  // crt-easymode lightened through its own #pragma parameters, set in the .glslp preset (RetroArch reads them there):
  // stock (scanlines 1.0, scanline brightness min 0.35, mask 0.3) is dark and fringes text with the RGB mask on phones.
  const CRT_LIGHT = { SCANLINE_STRENGTH: 0.6, SCANLINE_BRIGHT_MIN: 0.5, MASK_STRENGTH: 0.15 };
  function preset(k) {
    const p = window.EJS_SHADERS[k];
    if (k !== SHADERS.crt) return p;
    const params = `parameters = "${Object.keys(CRT_LIGHT).join(';')}"\n` + Object.entries(CRT_LIGHT).map(([n, v]) => `${n} = ${v}\n`).join('');
    return { ...p, shader: { type: 'text', value: p.shader.value + params } };
  }
  function applyShader() { if (started) emu.changeSettingOption('shader', SHADERS[shaderKey()] ?? 'disabled'); }
  function renderShader() {
    const sel = $('shader');
    if (!sel.options.length) for (const k of Object.keys(SHADERS)) sel.add(new Option(k, k));
    for (const o of sel.options) o.textContent = T[lang].shader[o.value];
    sel.value = shaderKey();
  }
  $('shader').addEventListener('change', () => {
    game.shader = $('shader').value;
    applyShader();
    writeGame().catch((e) => toast(t('fsFail', e.message)));
    $('stage').focus();
  });

  // ── input ids ─────────────────────────────────────────────────────────
  // EmulatorJS simulate_input indices are libretro RetroPad ids.
  const R = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 };
  // Genesis Plus GX 6-button pad (libretro.c osd_input_update): RetroPad Y/B/A → Genesis A/B/C, L/X/R → X/Y/Z,
  // SELECT → MODE. The core auto-selects the 6-button pad for games whose header lists it ("J6", e.g. SF2), else 3.
  const MD = { X: R.L, Y: R.X, Z: R.R, A: R.Y, B: R.B, C: R.A };
  // Master System / Game Gear 2-button pad: RetroPad B → button 1, A → button 2.
  const keyMap = () => ({
    KeyW: R.UP, KeyS: R.DOWN, KeyA: R.LEFT, KeyD: R.RIGHT, Enter: R.START, NumpadEnter: R.START, Space: R.SELECT,
    ...(sys.six ? { KeyU: MD.X, KeyI: MD.Y, KeyO: MD.Z, KeyJ: MD.A, KeyK: MD.B, KeyL: MD.C } : { KeyJ: R.B, KeyK: R.A }),
  });
  // Standard-mapping gamepad button index → RetroPad id. 4 (LB) = our pause, 12–15 + left stick = directions.
  const padMap = () => ({
    8: R.SELECT, 9: R.START,
    ...(sys.six ? { 2: MD.X, 3: MD.Y, 5: MD.Z, 0: MD.A, 1: MD.B, 7: MD.C } : { 0: R.B, 1: R.A }),
  });

  // ── state ─────────────────────────────────────────────────────────────
  let file = null;                 // init.file: the bundle directory (workspace-relative path)
  let game = { version: 1 };       // game.json as read; unknown keys are kept on write
  let rom = null;                  // { name, bytes } handed to EmulatorJS
  let romPath = null, readError = null, entries = null;
  let sys = null, emu = null, booting = false, started = false;
  const pauseWhy = new Set(); // 'user' | 'blur' | 'help'
  const src = { kb: {}, pad: {}, touch: {} }, sent = {}; // per-source held RetroPad ids → what the core last got
  let audio = { volume: 0.5, muted: false };
  try { audio = { ...audio, ...JSON.parse(localStorage.getItem(LS + 'audio') || '{}') }; } catch {}
  let touchMode = ['auto', 'on', 'off'].includes(localStorage.getItem(LS + 'touch')) ? localStorage.getItem(LS + 'touch') : 'auto';
  const touchCapable = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  let lastInput = null; // 'kb' | 'pad' | 'touch' — drives the auto touch-controls mode
  let padName = null;

  function setInput(from, id, on) {
    src[from][id] = on;
    const want = !!(src.kb[id] || src.pad[id] || src.touch[id]);
    if (!started || sent[id] === want) return;
    sent[id] = want;
    emu.gameManager.simulateInput(0, id, want ? 1 : 0);
  }
  const releaseAll = (from) => { for (const id in src[from]) if (src[from][id]) setInput(from, +id, false); };

  // ── game.json / ROM ───────────────────────────────────────────────────
  function writeGame() {
    const { version, rom: r, shader, ...rest } = game;
    const out = { version: 1, ...(r ? { rom: r } : {}), shader: shaderKey(), ...rest };
    return fsCall('write', 'game.json', { buffer: enc(JSON.stringify(out, null, 2) + '\n') });
  }
  async function prepare() {
    show('busy');
    try { game = { version: 1, ...JSON.parse(new TextDecoder().decode((await fsCall('read', 'game.json')).buffer)) }; }
    catch (e) { if (e.code !== 'not-found') console.warn('[megadrive] game.json', e); game = { version: 1 }; }
    renderShader();
    if (typeof game.rom !== 'string' || !game.rom) return show('choose');
    const loc = resolveRom(file.path, game.rom);
    romPath = loc?.path ?? null;
    readError = null;
    let buf;
    try {
      if (!loc) return show('missing');
      buf = (await fsCall('read', loc.path, { scope: loc.scope })).buffer;
    } catch (e) {
      if (e.code !== 'not-found' && e.code !== 'invalid-path') readError = e.message;
      return show('missing');
    }
    const u8 = new Uint8Array(buf), kind = archiveKind(u8);
    entries = null;
    if (kind) {
      let files;
      try { files = await extract(buf, kind); } catch (e) { console.warn('[megadrive] extract', e); return show('notrom'); }
      entries = files.map((f) => f.name);
      const hit = romIn(files);
      if (!hit) return show('notrom');
      rom = { name: baseOf(hit.name), bytes: hit.data };
    } else if (EXT_SYS[extOf(romPath)]) rom = { name: baseOf(romPath), bytes: u8 };
    else return show('notrom');
    sys = SYS[EXT_SYS[extOf(rom.name)]];
    show('start');
  }
  async function pickRom() {
    let r;
    try { r = await request({ type: 'pick', accept: ACCEPT }); }
    catch (e) { if (e.code !== 'cancelled') toast(t('pickFail', e.message)); return; }
    // inside the workspace the host answers workspace-relative → stored bundle-relative, so the bundle stays portable;
    // outside it the absolute path is stored as-is
    game.rom = isAbs(r.path) ? r.path : relFromBundle(file.path, r.path);
    try { await writeGame(); } catch (e) { return toast(t('fsFail', e.message)); }
    // EmulatorJS can't swap games in place; a reload sends a fresh `ready`, and the host answers with a new `init`
    if (emu) location.reload();
    else prepare();
  }
  for (const b of document.querySelectorAll('.pick')) b.addEventListener('click', pickRom);

  // ── pause ─────────────────────────────────────────────────────────────
  function setPause(why, on) {
    if (!started) return;
    const was = pauseWhy.size > 0;
    if (on) pauseWhy.add(why); else pauseWhy.delete(why);
    const now = pauseWhy.size > 0;
    if (now !== was) { if (now) emu.pause(); else emu.play(); }
    renderPause();
  }
  const togglePause = () => setPause('user', !pauseWhy.has('user'));
  function renderPause() {
    const p = $('paused');
    p.hidden = !(pauseWhy.has('blur') || pauseWhy.has('user'));
    $('pausedText').textContent = pauseWhy.has('blur') ? t('pausedBlur') : t('pausedUser');
    $('bPause').textContent = pauseWhy.has('user') ? t('resume') : t('pause');
    $('vPause').textContent = t('vPause');
  }
  // Focus lost (typing in Halo's chat, another window) → pause so WASD doesn't go nowhere; focus back → resume.
  // The host focuses the iframe after entering / leaving maximize, so that resumes without a click. A user pause stays.
  addEventListener('blur', () => { releaseAll('kb'); stickEnd(); setPause('blur', true); });
  addEventListener('focus', () => setPause('blur', false));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setPause('blur', true);
    else if (document.hasFocus()) setPause('blur', false);
  });
  // clicking the overlay is an explicit resume: it clears a user pause too (touch players can't reach P)
  $('paused').addEventListener('pointerdown', () => { window.focus(); $('stage').focus(); setPause('user', false); setPause('blur', false); });

  // ── keyboard ──────────────────────────────────────────────────────────
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.code === 'Escape') return; // Esc stays with the host / browser
    const down = e.type === 'keydown';
    if (!started) {
      if (down && !booting && !$('start').hidden && (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space')) { e.preventDefault(); boot(); }
      return;
    }
    const id = keyMap()[e.code];
    if (id !== undefined) {
      e.preventDefault();
      if (e.isTrusted && down) noteInput('kb');
      if (!e.repeat) setInput('kb', id, down);
      return;
    }
    const act = { KeyP: togglePause, F2: saveState, F4: loadState, KeyM: toggleMute }[e.code];
    if (!act) return;
    e.preventDefault();
    if (down && !e.repeat) { if (e.isTrusted) noteInput('kb'); act(); }
  }
  addEventListener('keydown', onKey, true);
  addEventListener('keyup', onKey, true);

  // ── gamepad ───────────────────────────────────────────────────────────
  // The Gamepad API has no button events, so this polls once per frame (EmulatorJS's own handler polls every 10 ms);
  // it also catches pads Chrome connects without a gamepadconnected event inside iframes.
  let lbPrev = false;
  function padLoop() {
    requestAnimationFrame(padLoop);
    let gp = null;
    try { gp = [...(navigator.getGamepads?.() ?? [])].find((p) => p && p.connected !== false) ?? null; } catch {}
    const name = gp ? simplifyPadName(gp.id) : null;
    if (name !== padName) {
      padName = name;
      if (name) noteInput('pad'); else { releaseAll('pad'); renderTouch(); }
      renderChip();
    }
    if (!gp || !started) return;
    const on = (i) => !!gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5);
    const ax = gp.axes || [];
    const dirs = [[R.UP, on(12) || ax[1] < -0.5], [R.DOWN, on(13) || ax[1] > 0.5], [R.LEFT, on(14) || ax[0] < -0.5], [R.RIGHT, on(15) || ax[0] > 0.5]];
    let any = false;
    for (const [id, p] of dirs) { any ||= p; setInput('pad', id, p); }
    for (const [i, id] of Object.entries(padMap())) { const p = on(+i); any ||= p; setInput('pad', id, p); }
    const lb = on(4);
    if (lb && !lbPrev) togglePause();
    lbPrev = lb;
    if (any || lb) noteInput('pad');
  }
  const simplifyPadName = (id) => (id.replace(/\s*\(.*\)\s*$/, '').replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '').trim() || id).slice(0, 40);
  addEventListener('gamepadconnected', () => {});    // listening makes some browsers expose pads sooner; padLoop does the work
  addEventListener('gamepaddisconnected', () => {});
  function renderChip() {
    const c = $('pad');
    c.textContent = !window.isSecureContext || !navigator.getGamepads ? t('padInsecure') : padName ? t('padOn', padName) : t('padOff');
    c.classList.toggle('on', !!padName);
  }

  // ── touch controls: our floating stick + EmulatorJS's buttons ─────────
  function noteInput(from) { if (lastInput !== from) { lastInput = from; renderTouch(); } }
  function touchShown() {
    if (touchMode !== 'auto') return touchMode === 'on';
    return touchCapable && (lastInput === 'touch' || (lastInput === null && !padName));
  }
  function renderTouch() {
    $('bTouch').textContent = t('touch', touchMode);
    if (!started) return;
    const show = touchShown();
    // a class + !important rule, not emu.toggleVirtualGamepad(): EmulatorJS's handleResize() re-hides a gamepad that
    // was display:none when it ran (a 250 ms timer, also armed during start), which would undo a show right after it
    $('stage').classList.toggle('vg-on', show);
    $('vPause').hidden = !show;
    if (!show) stickEnd();
  }
  addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') noteInput('touch'); }, true);
  addEventListener('touchstart', () => noteInput('touch'), { capture: true, passive: true });
  $('bTouch').addEventListener('click', () => {
    touchMode = { auto: 'on', on: 'off', off: 'auto' }[touchMode];
    localStorage.setItem(LS + 'touch', touchMode);
    renderTouch();
  });
  // The stick lives in the left half of the game area below the top 56 px (the host's touch exit × sits top-left).
  // A touch there centres the stick under the finger; the angle picks one of 8 directions (a diagonal = two RetroPad
  // directions) once the knob leaves the deadzone. Only the touch that started it moves it, so the buttons on the right
  // stay multi-touch. EmulatorJS's own d-pad is fixed in place and its "zone" stick is nipplejs in static mode
  // (not shipped), so neither can float.
  const STICK_R = 56, DEAD = 0.3;
  const zone = $('stick'), base = $('stickBase'), knob = $('stickKnob');
  let stickId = null, stickO = null;
  const ownTouch = (e) => [...e.changedTouches].find((x) => x.identifier === stickId);
  function stickDirs(dx, dy) {
    const on = { [R.UP]: false, [R.DOWN]: false, [R.LEFT]: false, [R.RIGHT]: false };
    if (Math.hypot(dx, dy) >= STICK_R * DEAD) {
      const s = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8; // 0 = right, then clockwise (screen y grows down)
      on[R.RIGHT] = s === 7 || s <= 1; on[R.DOWN] = s >= 1 && s <= 3; on[R.LEFT] = s >= 3 && s <= 5; on[R.UP] = s >= 5 && s <= 7;
    }
    for (const id in on) setInput('touch', +id, on[id]);
  }
  zone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (stickId !== null) return;
    const tt = e.changedTouches[0], r = zone.getBoundingClientRect();
    stickId = tt.identifier; stickO = { x: tt.clientX, y: tt.clientY };
    zone.classList.add('active');
    base.style.left = `${tt.clientX - r.left}px`; base.style.top = `${tt.clientY - r.top}px`;
    knob.style.transform = '';
  }, { passive: false });
  zone.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const tt = ownTouch(e);
    if (!tt) return;
    const dx = tt.clientX - stickO.x, dy = tt.clientY - stickO.y, d = Math.hypot(dx, dy), k = d > STICK_R ? STICK_R / d : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    stickDirs(dx, dy);
  }, { passive: false });
  function stickEnd(e) {
    if (stickId === null || (e && !ownTouch(e))) return;
    stickId = null;
    zone.classList.remove('active'); // back to the resting hint bottom-left (CSS transition)
    base.style.left = base.style.top = knob.style.transform = '';
    releaseAll('touch');
  }
  zone.addEventListener('touchend', stickEnd);
  zone.addEventListener('touchcancel', stickEnd);
  // Buttons: 2×3 grid bottom-right in the same places as U I O / J K L, coin · start · pause bottom-centre (pause is
  // ours, see vPause). Positions are EmulatorJS's own segaMD layout; style.css moves the containers into the corners
  // and keeps the top band clear for the host's maximize × and reply toast.
  function vgLayout() {
    const b = (id, text, right, top, v) => ({ type: 'button', id, text, location: 'right', right, top, fontSize: 14, bold: true, input_value: v });
    const L = T[lang];
    const pads = sys.six
      ? [b('x', 'X', 145, 0, MD.X), b('y', 'Y', 75, 0, MD.Y), b('z', 'Z', 5, 0, MD.Z),
        b('a', 'A', 145, 70, MD.A), b('b', 'B', 75, 70, MD.B), b('c', 'C', 5, 70, MD.C)]
      : [b('b1', '1', 75, 70, R.B), b('b2', '2', 5, 70, R.A)];
    return [
      ...pads,
      { type: 'button', id: 'mode', text: L.vCoin, location: 'center', left: 0, fontSize: 13, block: true, input_value: R.SELECT },
      { type: 'button', id: 'start', text: L.vStart, location: 'center', left: 64, fontSize: 13, block: true, input_value: R.START },
    ];
  }
  function relabelTouch() {
    const L = T[lang];
    const set = (cls, s) => { const el = document.querySelector(`.ejs_virtualGamepad_button.b_${cls}`); if (el) el.textContent = s; };
    set('mode', L.vCoin); set('start', L.vStart);
  }
  $('vPause').addEventListener('touchstart', (e) => { e.preventDefault(); togglePause(); });
  $('vPause').addEventListener('click', togglePause);

  // ── save / load / audio / fullscreen ─────────────────────────────────
  let toastTimer = 0;
  function toast(s) {
    const el = $('toast');
    el.textContent = s; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }
  // One quick-save slot per ROM, in the bundle: saves/<ROM file name without extension>.state (raw core state).
  const statePath = () => `saves/${stem(game.rom)}.state`;
  async function saveState() {
    if (!started) return;
    try { await fsCall('write', statePath(), { buffer: emu.gameManager.getState().buffer }); toast(t('saved')); } // getState() copies
    catch (e) { console.warn('[megadrive] save state', e); toast(t('saveFail')); }
  }
  async function loadState() {
    if (!started) return;
    let buf;
    try { buf = (await fsCall('read', statePath())).buffer; } catch (e) { return toast(e.code === 'not-found' ? t('noSave') : t('loadFail')); }
    emu.gameManager.loadState(new Uint8Array(buf));
    toast(t('loaded'));
  }
  function applyAudio() {
    localStorage.setItem(LS + 'audio', JSON.stringify(audio));
    $('vol').value = String(audio.volume);
    $('bMute').textContent = audio.muted || audio.volume === 0 ? '🔇' : '🔊';
    if (started) emu.setVolume(audio.muted ? 0 : audio.volume);
  }
  function toggleMute() { audio.muted = !audio.muted; applyAudio(); }
  $('bMute').addEventListener('click', toggleMute);
  $('vol').addEventListener('input', () => { audio.volume = Number($('vol').value); audio.muted = false; applyAudio(); });
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('stage').requestFullscreen?.().catch(() => {});
  }
  $('bFull').addEventListener('click', toggleFull);
  $('game').addEventListener('dblclick', toggleFull);
  $('bPause').addEventListener('click', togglePause);
  $('bSave').addEventListener('click', saveState);
  $('bLoad').addEventListener('click', loadState);
  // a clicked toolbar button must not keep focus: Enter / Space would press it again instead of reaching the game
  $('bar').addEventListener('click', (e) => { if (e.target.closest('button')) $('stage').focus(); });

  // ── help ──────────────────────────────────────────────────────────────
  function keymap() {
    const L = T[lang], x = (k) => `<kbd>${k}</kbd>`;
    const six = !sys || sys.six;
    const btn = (k, name) => `<span class="key">${x(k)}<small>${name}</small></span>`;
    const diagram = `<div class="diagram">
      <div class="wasd"><span></span>${btn('W', '↑')}<span></span>${btn('A', '←')}${btn('S', '↓')}${btn('D', '→')}</div>
      <div class="six">${six
        ? btn('U', 'X') + btn('I', 'Y') + btn('O', 'Z') + btn('J', 'A') + btn('K', 'B') + btn('L', 'C')
        : btn('J', '1') + btn('K', '2')}</div></div>`;
    const rows = [
      [L.dir, 'W A S D', L.dpad],
      ...(six
        ? [[L.btn('X'), 'U', 'X'], [L.btn('Y'), 'I', 'Y'], [L.btn('Z'), 'O', 'RB'],
          [L.btn('A'), 'J', 'A'], [L.btn('B'), 'K', 'B'], [L.btn('C'), 'L', 'RT']]
        : [[L.btn(1), 'J', 'A'], [L.btn(2), 'K', 'B']]),
      [L.startK, 'Enter', 'Start'], [six ? L.coin : L.coinMS, 'Space', 'Back / Select'], [L.pauseK, 'P', 'LB'],
      [L.qsave, 'F2', L.none], [L.qload, 'F4', L.none], [L.mute, 'M', L.none], [L.fullK, L.fullHow, L.none],
    ];
    const table = `<table><thead><tr><th>${L.act}</th><th>${L.kb}</th><th>${L.gp}</th></tr></thead><tbody>${
      rows.map(([a, k, g]) => `<tr><td>${a}</td><td>${k.length <= 7 ? k.split(' ').map(x).join(' ') : k}</td><td>${g}</td></tr>`).join('')}</tbody></table>`;
    return diagram + table;
  }
  function renderHelp() {
    const L = T[lang];
    $('helpBody').innerHTML = `<h2>${t('help').replace('⌨ ', '')}</h2>${keymap()}<ul class="notes">${L.notes.map((n) => `<li>${n}</li>`).join('')}</ul><p class="lic">${L.lic}</p>`;
    $('startHelp').innerHTML = keymap();
  }
  function showHelp(on) {
    $('help').hidden = !on;
    setPause('help', on);
  }
  $('bHelp').addEventListener('click', () => showHelp($('help').hidden));
  $('bHelpClose').addEventListener('click', () => showHelp(false));

  // ── screens ───────────────────────────────────────────────────────────
  const SCREENS = ['busy', 'choose', 'start', 'missing', 'notrom'];
  let screen = 'busy';
  function show(name) {
    screen = name;
    for (const s of SCREENS) $(s).hidden = s !== name;
    renderTexts();
  }
  function renderTexts() {
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll('[data-i]')) el.textContent = t(el.dataset.i);
    const title = file ? file.name.replace(/\.mega$/i, '') : '';
    for (const el of document.querySelectorAll('.title')) el.textContent = title;
    $('startSys').textContent = sys?.name ?? '';
    $('sys').textContent = sys?.name ?? '';
    $('bStart').textContent = t('startGame', romPath ? baseOf(romPath) : '');
    $('missingText').textContent = t('missingText', game.rom ?? '');
    $('readError').hidden = !readError;
    $('readError').textContent = readError ? t('readFail', readError) : '';
    renderPause(); renderChip(); renderTouch(); renderHelp(); relabelTouch(); renderShader();
    if (screen === 'notrom') renderEntries();
  }
  function renderEntries() {
    const ul = $('entries');
    ul.textContent = '';
    const li = (s, cls) => { const el = document.createElement('li'); el.textContent = s; if (cls) el.className = cls; ul.append(el); };
    $('notromName').textContent = romPath ?? '';
    if (!entries) return li(t('notArchive'));
    li(t('entries', entries.length), 'head');
    for (const n of entries.slice(0, 50)) li(n);
    if (entries.length > 50) li(t('more', entries.length - 50));
  }

  // ── boot ──────────────────────────────────────────────────────────────
  const loadScript = (s) => new Promise((ok, fail) => {
    const el = document.createElement('script');
    el.src = s; el.onload = ok; el.onerror = () => fail(new Error(`failed to load ${s}`));
    document.head.append(el);
  });
  async function boot() {
    if (booting || started || !sys) return;
    booting = true;
    $('start').hidden = true;
    $('stage').focus();
    try {
      for (const n of ['storage', 'gamepad', 'GameManager', 'compression', 'shaders', 'emulator']) await loadScript(`emulatorjs/src/${n}.js`);
      // Our keyboard / gamepad layer above drives input; with these off nothing reaches the core twice, and
      // EmulatorJS no longer preventDefaults every key (Esc included) on its element.
      window.EmulatorJS.prototype.keyChange = function () {};
      window.EmulatorJS.prototype.gamepadEvent = function () {};
      const off = Object.fromEntries(['playPause', 'restart', 'mute', 'settings', 'fullscreen', 'saveState', 'loadState', 'screenRecord', 'gamepad', 'cheat',
        'volumeSlider', 'saveSavFiles', 'loadSavFiles', 'quickSave', 'quickLoad', 'screenshot', 'cacheManager', 'exitEmulation', 'netplay', 'diskButton'].map((k) => [k, false]));
      const config = {
        gameUrl: new File([rom.bytes], rom.name), // already unpacked by prepare()
        dataPath: 'emulatorjs/',
        system: sys.core,
        gameName: rom.name,
        volume: audio.volume,
        defaultControllers: { 0: {}, 1: {}, 2: {}, 3: {} },
        startOnLoad: true, // our start screen already took the click (the user gesture audio needs)
        disableDatabases: true, // no IndexedDB copy of ROM / core — both are local already
        disableLocalStorage: true, // EmulatorJS settings stay out of the admin origin's localStorage
        backgroundColor: '#000', color: '#7aa2f7',
        buttonOpts: off,
        VirtualGamepadSettings: vgLayout(),
        shaders: Object.fromEntries(Object.values(SHADERS).filter(Boolean).map((k) => [k, preset(k)])),
      };
      if (lang === 'zh') { config.language = 'zh-CN'; config.langJson = await (await fetch('emulatorjs/localization/zh-CN.json')).json(); }
      emu = window.EJS_emulator = new window.EmulatorJS('#game', config);
      emu.on('start', onStarted);
    } catch (err) {
      booting = false;
      post({ type: 'error', message: err?.message ?? String(err) });
    }
  }
  function onStarted() {
    booting = false; started = true;
    for (const id of ['bPause', 'bSave', 'bLoad']) $(id).disabled = false;
    document.querySelector('.ejs_virtualGamepad_bottom')?.append($('vPause'));
    applyAudio();
    applyShader();
    renderTexts();
    if (!document.hasFocus()) setPause('blur', true);
    $('stage').focus();
  }
  $('bStart').addEventListener('click', boot);

  // ── theme ─────────────────────────────────────────────────────────────
  const TOKENS = ['background', 'foreground', 'card', 'card-foreground', 'border', 'muted', 'muted-foreground', 'primary', 'primary-foreground', 'secondary', 'secondary-foreground'];
  function applyTheme(m) {
    const root = document.documentElement;
    root.dataset.theme = m.theme === 'light' ? 'light' : 'dark';
    const v = m.themeVars && typeof m.themeVars === 'object' ? m.themeVars : {};
    for (const k of TOKENS) { if (v[k]) root.style.setProperty(`--h-${k}`, v[k]); else root.style.removeProperty(`--h-${k}`); }
  }

  // ── protocol ──────────────────────────────────────────────────────────
  addEventListener('message', (e) => {
    if (e.source !== parent || e.data?.haloExt !== 1) return;
    const m = e.data;
    if (m.type === 'fs-result' || m.type === 'pick-result') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m); else p.reject(Object.assign(new Error(m.error), { code: m.code }));
    } else if (m.type === 'init') {
      file = m.file; lang = m.lang === 'en' ? 'en' : 'zh';
      applyTheme(m);
      $('bPick').disabled = false;
      prepare();
    } else if (m.type === 'theme') applyTheme(m);
    else if (m.type === 'lang') { lang = m.lang === 'en' ? 'en' : 'zh'; renderTexts(); }
  });
  applyAudio(); show('busy');
  requestAnimationFrame(padLoop);
  post({ type: 'ready', protocol: 1 });
})();
