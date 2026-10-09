# megadrive — Mega Drive / Genesis emulator

Halo Canvas preview extension: plays **Sega Mega Drive / Genesis** ROMs — and Master System / Game Gear — right in the Canvas, with [EmulatorJS](https://emulatorjs.org) 4.2.3 and the Genesis Plus GX core. Fully offline: the emulator and core are bundled (~1.5 MB zip), nothing is fetched from the network. **No ROMs are included** — use your own.

## A `.mega` folder per game

The extension opens a **`.mega` bundle** — a folder Halo shows as one file (`bundle: true`). Make one with **New File…** in the explorer's right-click menu, e.g. `My Game.mega`. It holds:

```
My Game.mega/
  game.json          {"version": 1, "rom": "../roms/mygame.zip", "shader": "crt"}
  saves/mygame.state quick save (F2), one per ROM
```

- **The ROM stays where it is — anywhere on the machine.** 「选择 ROM」 / *Choose ROM* opens Halo's file picker (capability `fs-read`, starting in the bundle folder; it can browse the whole machine). A ROM inside the workspace is stored in `game.json` as a path relative to the bundle (`../roms/mygame.zip`, or `mygame.zip` for a ROM inside it), so the bundle stays portable; a ROM outside the workspace is stored as its absolute path (`/home/me/roms/mygame.zip`, `C:/roms/mygame.zip`). Every open reads the ROM from there, read-only — `fs` `scope: 'workspace'` for a relative path, `scope: 'system'` for an absolute one. Nothing but `game.json` and `saves/` is ever written into the bundle — never the ROM or anything extracted from it.
- Accepts `.zip` and `.7z` archives holding a ROM, and bare `.md` `.gen` `.smd` `.bin` `.sms` `.gg`. Archives are unpacked in the page with EmulatorJS's own extractors; the first `.md` / `.gen` / `.smd` / `.sms` / `.gg` inside wins, else a single `.bin` of at least 128 KiB. An archive without one shows 「压缩包里没有 MD ROM（支持 .md .gen .smd .bin .sms .gg）」 with its file list.
- Opening a bundle with a ROM goes straight to 「▶ 开始 · <ROM name>」 — click or press Enter. A ROM that was moved or deleted shows the stored path and 「换一个 ROM」 / *Change ROM*. The toolbar's **📁 Change ROM** rewrites `game.json` and reloads the page.
- `game.json` is written pretty-printed; keys this version doesn't know are kept. `.zip` / `.md` files in the workspace are no longer claimed — they open as Halo normally opens them.

## Controls

| Action | Keyboard (1P) | Gamepad (standard mapping) |
|---|---|---|
| Move | W A S D | D-pad / left stick |
| X Y Z (top row) | U I O | X Y RB |
| A B C (bottom row) | J K L | A B RT |
| Start | Enter | Start |
| Coin / Mode | Space | Back / Select |
| Pause / resume | P | LB |
| Quick save / load | F2 / F4 | — |
| Mute | M | — |
| Fullscreen | toolbar button / double-click | — |

Master System / Game Gear use buttons 1 / 2 = **J / K** (pad A / B). The labels are the Genesis 6-button pad's own letters (top row X Y Z, bottom row A B C), which Genesis Plus GX selects for games that support it (3-button games use A B C only).

How the keys reach the core (libretro RetroPad ids, Genesis Plus GX's pad mapping): X→L, Y→X, Z→R, A→Y, B→B, C→A, Mode→Select, Start→Start. EmulatorJS's own keyboard / gamepad handling is switched off; `app.js` owns every binding, so both the d-pad and the left stick move, and the help panel (⌨ toolbar button) is always what is actually bound.

- **Pause**: P / pad LB / toolbar. The game also pauses when the iframe loses focus (typing in the Halo chat, another window) and resumes when it gets focus back; a pause you made yourself stays until you resume it.
- **Saves**: F2 / F4 (or the toolbar) keep one quick-save state per ROM in the bundle, `saves/<ROM file name without extension>.state` — it travels with the workspace. In-game battery saves (SRAM) stay in this browser. Switching editor tabs unmounts the game, so save first.
- **Display** (「画面」): *Pixel* (no filter), *Soft* (bicubic), *HD* (SABR edge smoothing), *CRT* (default; a light crt-easymode — scanlines + mask, no curvature). CRT is the default for a new bundle and for a `game.json` without `shader`; a shader `game.json` already names is kept. Stock easymode is dark and its RGB mask fringes small text on phones, so its own parameters are set lighter in the preset: `SCANLINE_STRENGTH` 0.6 (stock 1.0), `SCANLINE_BRIGHT_MIN` 0.5 (0.35), `MASK_STRENGTH` 0.15 (0.3). Applied live and stored in `game.json`. Picked for speed on WebGL 1: all four hold 60 fps on a software renderer at desktop and phone sizes, where crt-geom / crt-aperture / crt-lottes fell to 41 / 47 / 13 fps and were left out.
- **Esc** is not bound — in a maximized Halo canvas Esc exits the maximized view.
- **Touch controls**: a **floating stick** on the left — touch anywhere in the left half of the game (below the top 56 px) and the stick centres under your finger; 8 directions with a deadzone, the knob clamps at the rim, and on release it fades back to a resting spot bottom-left. Buttons are EmulatorJS's on-screen ones, restyled: 2×3 grid bottom-right labelled X Y Z / A B C, coin · start · pause bottom-centre. All ~40% opaque, nothing in the top 56 px (the host's controls). The stick follows only the touch that started it, so it and several buttons work at once. *Auto* (default) shows the controls on touch screens until a keyboard key or a gamepad is used, and brings them back on the next touch; the toolbar button cycles **Auto / On / Off** (remembered per browser).
- **Gamepads** need a secure context (HTTPS or localhost); a Bluetooth pad shows up after its first button press. The toolbar chip shows the connected pad.

## Install

- Agent: `/extension install megadrive`
- Admin → Extensions → upload `megadrive-2.0.0.zip` (from the GitHub release, ~1.5 MB)
- Manual: `./fetch-deps.sh && cp -r extensions/megadrive ~/.halo/global/extensions/`

## Package

```bash
extensions/megadrive/fetch-deps.sh          # npm EmulatorJS + Genesis Plus GX core (sha256-checked) → emulatorjs/ (~2 MB)
node scripts/pack.mjs extensions/megadrive   # → dist/megadrive-2.0.0.zip
```

`emulatorjs/` is gitignored and ships only inside the release zip. To upgrade, bump the versions + sha256 in `fetch-deps.sh` (and `NOTICE`), re-run, check that `emulatorjs-offline.patch` still applies, and re-test: pick a ROM (zip, 7z, bare), boot, the six buttons, gamepad, save / load into `saves/`, the stick + touch buttons, each display option, no network requests.

## Limits

- Single player (1P). No netplay, cheats, rewind or fast-forward.
- Sega CD / 32X / SG-1000 / Pico are not offered (32X needs another core; CD needs BIOS and disc images).
- Needs Halo with bundle extensions + the `pick` frame and the `fs-read` capability (`fs` scopes `workspace` / `system`).
- The core is the WebGL 1 build EmulatorJS 4.2.3 selects by default; the threaded builds need cross-origin isolation, which Halo does not send.

## Licenses

`LICENSE` (glue code, MIT) and `NOTICE`. EmulatorJS is **GPL-3.0** (`emulatorjs/LICENSE`); the display filters in `emulatorjs/src/shaders.js` are libretro shaders under the GPL (see `NOTICE`); the Genesis Plus GX core is under its own **non-commercial** license (`LICENSE-GENESIS-PLUS-GX.txt`) — this extension may not be sold or used in a commercial product or activity.

Not affiliated with or endorsed by Sega. Mega Drive, Genesis, Master System and Game Gear are trademarks of their respective owners; the names are used only to say which ROM formats the extension plays.
