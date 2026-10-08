'use strict';
// Halo canvas extension "megadrive": Sega Mega Drive / Genesis (+ Master System / Game Gear) on EmulatorJS 4.2.3 with
// the Genesis Plus GX core, fully offline. Halo protocol v1: ready → init → load {buffer}; theme / lang frames live.
//
// EmulatorJS owns the core, ROM unzip, canvas, audio, save-state storage and the touch gamepad. Keyboard and
// physical gamepad input are ours (EmulatorJS's handlers are switched off in boot()): EmulatorJS binds one key or
// pad button per control, so it can't drive a direction from both the d-pad and the left stick, and it has no
// pause button; one layer owning every binding also keeps the help panel truthful.
(() => {
  const $ = (id) => document.getElementById(id);
  const post = (m) => parent.postMessage({ haloExt: 1, ...m }, '*');
  const LS = 'halo-ext-megadrive:'; // the iframe shares the admin's origin, so its localStorage too

  // ── text ──────────────────────────────────────────────────────────────
  const T = {
    zh: {
      help: '⌨ 按键', pause: '⏸ 暂停', resume: '▶ 继续', save: '💾 存档', load: '📂 读档', full: '⛶ 全屏',
      touch: (m) => `🕹 虚拟手柄：${{ auto: '自动', on: '开', off: '关' }[m]}`,
      start: '点击开始', startKeys: '或按 Enter',
      padOn: (n) => `🎮 已连接：${n}`, padOff: '未检测到手柄 — 连接后按任意键唤醒', padInsecure: '手柄需要 HTTPS 或 localhost 访问',
      pausedBlur: '已暂停 — 点击画面继续', pausedUser: '已暂停 — 按 P（手柄 LB）或点击画面继续',
      saved: '已存档（F4 读档）', loaded: '已读档', noSave: '还没有存档 — 先按 F2', saveFail: '存档失败',
      notRom: '这个压缩包不是本扩展能打开的 ROM', notRomHint: '可在右上角「打开方式」换用其他查看器。',
      mdHint: '本扩展打开 Mega Drive / Genesis、Master System、Game Gear 的 ROM（压缩包里是 .md .gen .smd .bin .sms .gg 文件）。单独的 .md 文件请打包成 .zip 或改名为 .gen 再打开。',
      badZip: '读不出压缩包目录（文件可能已损坏）。', entries: (n) => `压缩包内容（${n} 项）`, more: (n) => `…还有 ${n} 项`,
      kb: '键盘（1P）', gp: '手柄', act: '动作',
      dir: '方向', lp: '轻拳', mp: '中拳', hp: '重拳', lk: '轻脚', mk: '中脚', hk: '重脚', b1: '按键 1', b2: '按键 2',
      startK: '开始', coin: '投币 / Mode', coinMS: '投币（无作用）', pauseK: '暂停 / 继续', qsave: '快速存档', qload: '快速读档', mute: '静音', fullK: '全屏',
      dpad: '十字键 / 左摇杆', fullHow: '工具栏按钮 / 双击画面', none: '—',
      notes: [
        '切换标签页会结束本局，先按 F2 存档。',
        '存档保存在本浏览器里（桌面客户端和网页版不互通）。',
        '在 Halo 里放大画布时，Esc 用于退出放大。',
        '触屏设备上会显示虚拟手柄；用了键盘或手柄就自动隐藏，再摸一下屏幕又会出现。工具栏「虚拟手柄」可切换 自动 / 开 / 关。',
        '蓝牙手柄连上后要先按一下任意键，浏览器才会识别。',
      ],
      lic: 'EmulatorJS 4.2.3（GPL-3.0）+ Genesis Plus GX（仅限非商业用途）· 不含任何游戏 ROM',
      vStart: '开始', vCoin: '投币', vPause: '暂停',
    },
    en: {
      help: '⌨ Keys', pause: '⏸ Pause', resume: '▶ Resume', save: '💾 Save', load: '📂 Load', full: '⛶ Fullscreen',
      touch: (m) => `🕹 Touch controls: ${{ auto: 'Auto', on: 'On', off: 'Off' }[m]}`,
      start: 'Click to start', startKeys: 'or press Enter',
      padOn: (n) => `🎮 Connected: ${n}`, padOff: 'No gamepad — press any button on it to wake it', padInsecure: 'Gamepads need HTTPS or localhost',
      pausedBlur: 'Paused — click the game to continue', pausedUser: 'Paused — press P (pad LB) or click the game to continue',
      saved: 'State saved (F4 to load)', loaded: 'State loaded', noSave: 'No saved state yet — press F2 first', saveFail: 'Save failed',
      notRom: 'This archive is not a ROM this extension can open', notRomHint: 'Use “Open with” at the top right to pick another viewer.',
      mdHint: 'This extension opens Mega Drive / Genesis, Master System and Game Gear ROMs (archives holding .md .gen .smd .bin .sms .gg). Zip a bare .md file or rename it to .gen first.',
      badZip: 'Could not read the archive directory (the file may be damaged).', entries: (n) => `Archive contents (${n})`, more: (n) => `…${n} more`,
      kb: 'Keyboard (1P)', gp: 'Gamepad', act: 'Action',
      dir: 'Move', lp: 'Light punch', mp: 'Medium punch', hp: 'Heavy punch', lk: 'Light kick', mk: 'Medium kick', hk: 'Heavy kick', b1: 'Button 1', b2: 'Button 2',
      startK: 'Start', coin: 'Coin / Mode', coinMS: 'Coin (unused)', pauseK: 'Pause / resume', qsave: 'Quick save', qload: 'Quick load', mute: 'Mute', fullK: 'Fullscreen',
      dpad: 'D-pad / left stick', fullHow: 'toolbar button / double-click the game', none: '—',
      notes: [
        'Switching editor tabs ends the game — press F2 to save first.',
        'Saves live in this browser (the desktop app and the web admin don’t share them).',
        'When the Halo canvas is maximized, Esc exits the maximized view.',
        'Touch screens get on-screen controls; they hide when you use a keyboard or gamepad and come back on the next touch. The “Touch controls” toolbar button cycles Auto / On / Off.',
        'A Bluetooth gamepad shows up only after you press one of its buttons.',
      ],
      lic: 'EmulatorJS 4.2.3 (GPL-3.0) + Genesis Plus GX (non-commercial use only) · no game ROMs included',
      vStart: 'Start', vCoin: 'Coin', vPause: 'Pause',
    },
  };
  let lang = 'zh';
  const t = (k, ...a) => { const v = T[lang][k] ?? T.en[k]; return typeof v === 'function' ? v(...a) : v; };

  // ── systems / routing ─────────────────────────────────────────────────
  // EmulatorJS picks the core from `system`: segaMD / segaGG resolve to genesis_plus_gx, but segaMS would resolve to
  // smsplus (not bundled), so SMS passes the core name itself (its control scheme then resolves to segaMS).
  const SYS = {
    md: { core: 'segaMD', name: 'Sega Genesis / Mega Drive', six: true },
    sms: { core: 'genesis_plus_gx', name: 'Sega Master System', six: false },
    gg: { core: 'segaGG', name: 'Sega Game Gear', six: false },
  };
  const EXT_SYS = { md: 'md', gen: 'md', smd: 'md', '32x': 'md', sms: 'sms', gg: 'gg' };
  const extOf = (n) => (n.match(/\.([^./]+)$/)?.[1] ?? '').toLowerCase();

  /** Central directory of a zip → [{name, size, dir}], or null if it isn't a readable zip. No dependency. */
  function zipEntries(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22, min = Math.max(0, u8.length - 65557); i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = [];
    for (let n = 0; n < count && off + 46 <= u8.length && dv.getUint32(off, true) === 0x02014b50; n++) {
      const size = dv.getUint32(off + 24, true);
      const nl = dv.getUint16(off + 28, true), xl = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true);
      const name = dec.decode(u8.subarray(off + 46, off + 46 + nl));
      out.push({ name, size, dir: name.endsWith('/') });
      off += 46 + nl + xl + cl;
    }
    return out;
  }

  /** Which console a zip holds, or null. `.bin` alone is ambiguous (plenty of non-console zips hold small .bin
   *  files), so it counts only as the zip's single .bin and at least 128 KiB — the smallest Mega Drive cartridge. */
  function zipSystem(entries) {
    const files = entries.filter((e) => !e.dir);
    for (const e of files) if (EXT_SYS[extOf(e.name)]) return EXT_SYS[extOf(e.name)];
    const bins = files.filter((e) => extOf(e.name) === 'bin');
    return bins.length === 1 && bins[0].size >= 128 * 1024 ? 'md' : null;
  }

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
  let file = null, rom = null, sys = null, sysKey = null, emu = null, booting = false, started = false;
  const pauseWhy = new Set(); // 'user' | 'blur' | 'help'
  const src = { kb: {}, pad: {} }, sent = {}; // per-source held RetroPad ids → what the core last got
  let audio = { volume: 0.5, muted: false };
  try { audio = { ...audio, ...JSON.parse(localStorage.getItem(LS + 'audio') || '{}') }; } catch {}
  let touchMode = ['auto', 'on', 'off'].includes(localStorage.getItem(LS + 'touch')) ? localStorage.getItem(LS + 'touch') : 'auto';
  const touchCapable = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  let lastInput = null; // 'kb' | 'pad' | 'touch' — drives the auto touch-controls mode
  let padName = null;

  function setInput(from, id, on) {
    src[from][id] = on;
    const want = !!(src.kb[id] || src.pad[id]);
    if (!started || sent[id] === want) return;
    sent[id] = want;
    emu.gameManager.simulateInput(0, id, want ? 1 : 0);
  }
  const releaseAll = (from) => { for (const id in src[from]) if (src[from][id]) setInput(from, +id, false); };

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
  addEventListener('blur', () => { releaseAll('kb'); setPause('blur', true); });
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

  // ── touch controls (EmulatorJS's built-in virtual gamepad) ────────────
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
  }
  addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') noteInput('touch'); }, true);
  addEventListener('touchstart', () => noteInput('touch'), { capture: true, passive: true });
  $('bTouch').addEventListener('click', () => {
    touchMode = { auto: 'on', on: 'off', off: 'auto' }[touchMode];
    localStorage.setItem(LS + 'touch', touchMode);
    renderTouch();
  });
  // Layout: 8-way d-pad bottom-left, 2×3 grid bottom-right in the same places as U I O / J K L, coin · start · pause
  // bottom-centre (pause is ours, see vPause). Positions are EmulatorJS's own segaMD layout; style.css moves the
  // containers into the corners and keeps the top band clear for the host's maximize × and reply toast.
  function vgLayout() {
    const b = (id, text, right, top, v) => ({ type: 'button', id, text, location: 'right', right, top, fontSize: 14, bold: true, input_value: v });
    const L = T[lang];
    const pads = sys.six
      ? [b('x', L.lp, 145, 0, MD.X), b('y', L.mp, 75, 0, MD.Y), b('z', L.hp, 5, 0, MD.Z),
        b('a', L.lk, 145, 70, MD.A), b('b', L.mk, 75, 70, MD.B), b('c', L.hk, 5, 70, MD.C)]
      : [b('b1', '1', 75, 70, R.B), b('b2', '2', 5, 70, R.A)];
    return [
      { type: 'dpad', id: 'dpad', location: 'left', left: '50%', right: '50%', joystickInput: false, inputValues: [R.UP, R.DOWN, R.LEFT, R.RIGHT] },
      ...pads,
      { type: 'button', id: 'mode', text: L.vCoin, location: 'center', left: 0, fontSize: 13, block: true, input_value: R.SELECT },
      { type: 'button', id: 'start', text: L.vStart, location: 'center', left: 64, fontSize: 13, block: true, input_value: R.START },
    ];
  }
  function relabelTouch() {
    const L = T[lang];
    const set = (cls, s) => { const el = document.querySelector(`.ejs_virtualGamepad_button.b_${cls}`); if (el) el.textContent = s; };
    if (sys?.six) { set('x', L.lp); set('y', L.mp); set('z', L.hp); set('a', L.lk); set('b', L.mk); set('c', L.hk); }
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
  // EmulatorJS's own "keep in browser" store (IndexedDB EmulatorJS-states, key = game name + ".state"), so states
  // survive the tab switch that unmounts this iframe; its quick-save slots live in the core's memory FS and wouldn't.
  const stateKey = () => emu.getBaseFileName() + '.state';
  function saveState() {
    if (!started) return;
    try { emu.storage.states.put(stateKey(), emu.gameManager.getState()); toast(t('saved')); } catch { toast(t('saveFail')); }
  }
  async function loadState() {
    if (!started) return;
    const st = await emu.storage.states.get(stateKey());
    if (!st) return toast(t('noSave'));
    emu.gameManager.loadState(st);
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
    const btn = (k, name, letter) => `<span class="key">${x(k)}<small>${name}${letter ? ` (${letter})` : ''}</small></span>`;
    const diagram = `<div class="diagram">
      <div class="wasd"><span></span>${btn('W', '↑')}<span></span>${btn('A', '←')}${btn('S', '↓')}${btn('D', '→')}</div>
      <div class="six">${six
        ? btn('U', L.lp, 'X') + btn('I', L.mp, 'Y') + btn('O', L.hp, 'Z') + btn('J', L.lk, 'A') + btn('K', L.mk, 'B') + btn('L', L.hk, 'C')
        : btn('J', L.b1) + btn('K', L.b2)}</div></div>`;
    const rows = [
      [L.dir, 'W A S D', L.dpad],
      ...(six
        ? [[`${L.lp} (X)`, 'U', 'X'], [`${L.mp} (Y)`, 'I', 'Y'], [`${L.hp} (Z)`, 'O', 'RB'],
          [`${L.lk} (A)`, 'J', 'A'], [`${L.mk} (B)`, 'K', 'B'], [`${L.hk} (C)`, 'L', 'RT']]
        : [[L.b1, 'J', 'A'], [L.b2, 'K', 'B']]),
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
  function renderTexts() {
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll('[data-i]')) el.textContent = t(el.dataset.i);
    $('startSys').textContent = sys?.name ?? '';
    $('sys').textContent = sys?.name ?? '';
    renderPause(); renderChip(); renderTouch(); renderHelp(); relabelTouch();
    if (!$('notrom').hidden) renderNotRom();
  }
  let notRomEntries = null;
  function renderNotRom() {
    const ul = $('entries');
    ul.textContent = '';
    if (!notRomEntries) { const li = document.createElement('li'); li.textContent = t('badZip'); ul.append(li); return; }
    const head = document.createElement('li');
    head.className = 'head'; head.textContent = t('entries', notRomEntries.length);
    ul.append(head);
    for (const e of notRomEntries.slice(0, 50)) { const li = document.createElement('li'); li.textContent = e.name; ul.append(li); }
    if (notRomEntries.length > 50) { const li = document.createElement('li'); li.textContent = t('more', notRomEntries.length - 50); ul.append(li); }
  }

  function onLoad(buffer) {
    if (booting || started) return; // a running game keeps its ROM; the host re-sends on external change
    rom = buffer;
    const ext = file?.ext || extOf(file?.name || '');
    sysKey = ext === 'zip' ? (() => { const e = zipEntries(buffer); notRomEntries = e; return e ? zipSystem(e) : null; })() : EXT_SYS[ext] ?? null;
    sys = sysKey ? SYS[sysKey] : null;
    $('start').hidden = !sys;
    $('notrom').hidden = !!sys;
    $('startName').textContent = file?.name ?? '';
    renderTexts();
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
      for (const n of ['storage', 'gamepad', 'GameManager', 'compression', 'emulator']) await loadScript(`emulatorjs/src/${n}.js`);
      // Our keyboard / gamepad layer above drives input; with these off nothing reaches the core twice, and
      // EmulatorJS no longer preventDefaults every key (Esc included) on its element.
      window.EmulatorJS.prototype.keyChange = function () {};
      window.EmulatorJS.prototype.gamepadEvent = function () {};
      const off = Object.fromEntries(['playPause', 'restart', 'mute', 'settings', 'fullscreen', 'saveState', 'loadState', 'screenRecord', 'gamepad', 'cheat',
        'volumeSlider', 'saveSavFiles', 'loadSavFiles', 'quickSave', 'quickLoad', 'screenshot', 'cacheManager', 'exitEmulation', 'netplay', 'diskButton'].map((k) => [k, false]));
      const config = {
        gameUrl: new File([rom], file.name), // EmulatorJS unzips it itself
        dataPath: 'emulatorjs/',
        system: sys.core,
        gameName: file.name, // save-state key
        volume: audio.volume,
        defaultControllers: { 0: {}, 1: {}, 2: {}, 3: {} },
        startOnLoad: true, // our start screen already took the click (the user gesture audio needs)
        disableDatabases: true, // no IndexedDB copy of ROM / core — both are local already; save states still use it
        disableLocalStorage: true, // EmulatorJS settings stay out of the admin origin's localStorage
        backgroundColor: '#000', color: '#7aa2f7',
        buttonOpts: off,
        VirtualGamepadSettings: vgLayout(),
        shaders: {},
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
    if (m.type === 'init') {
      file = m.file; lang = m.lang === 'en' ? 'en' : 'zh';
      applyTheme(m); renderTexts();
    } else if (m.type === 'load') onLoad(m.buffer);
    else if (m.type === 'theme') applyTheme(m);
    else if (m.type === 'lang') { lang = m.lang === 'en' ? 'en' : 'zh'; renderTexts(); }
  });
  applyAudio(); renderTexts();
  requestAnimationFrame(padLoop);
  post({ type: 'ready', protocol: 1 });
})();
