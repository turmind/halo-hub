# arcade — arcade emulator (FinalBurn Neo)

Halo Canvas preview extension: plays **arcade romsets** right in the Canvas, with [EmulatorJS](https://emulatorjs.org) 4.2.3 and the FinalBurn Neo (FBNeo) core. Fully offline: the emulator and core are bundled (~8.5 MB zip), nothing is fetched from the network. **No ROMs are included** — open romsets you have the right to use.

## An `.arcade` folder per game

The extension opens an **`.arcade` bundle** — a folder Halo shows as one file (`bundle: true`). Make one with **New File…** in the explorer's right-click menu, e.g. `gridlee.arcade`. It holds:

```
gridlee.arcade/
  game.json            {"version": 1, "rom": "../roms/gridlee.zip", "shader": "crt"}
  saves/gridlee.state  quick save (F2), one per romset
```

- **The romset stays where it is — anywhere on the machine.** 「选择 ROM」 / *Choose ROM* opens Halo's file picker (capability `fs-read`, starting in the bundle folder; it can browse the whole machine). A zip inside the workspace is stored in `game.json` as a path relative to the bundle (`../gridlee.zip`), so the bundle stays portable; a zip outside the workspace is stored as its absolute path (`/home/me/roms/gridlee.zip`, `C:/roms/gridlee.zip`). Every open reads the zip from there, read-only — `fs` `scope: 'workspace'` for a relative path, `scope: 'system'` for an absolute one — and hands it to FBNeo unchanged. Nothing but `game.json` and `saves/` is ever written into the bundle.
- Accepts **`.zip` romsets as distributed**: FBNeo finds the game by the zip's file name (`gridlee.zip` = romset `gridlee`, the MAME short name) and checks the chips inside itself, so don't rename, unpack or repack it. **`.7z` is not accepted**: this FBNeo build's `core.json` lists 7z, but it does not load 7z romsets (tested with LZMA2, LZMA and stored 7z of a working set — "No romset found").
- A zip FBNeo doesn't know (a name missing from this FBNeo build's game list, missing / wrong-version files) shows "FinalBurn Neo doesn't know the romset …" with the archive's file list and the short-name hint, instead of RetroArch's menu. A zip that clearly isn't a romset (empty, unreadable, or holding a console cartridge / disc image) shows "This file is not an arcade romset" with the same hint.
- Opening a bundle with a romset goes straight to 「▶ 开始 · <zip name>」 — click or press Enter. A zip that was moved or deleted shows the stored path and 「换一个 ROM」 / *Change ROM*; the toolbar's **📁 Change ROM** rewrites `game.json` and reloads the page.
- `game.json` is written pretty-printed; keys this version doesn't know are kept. `.zip` files in the workspace are no longer claimed — they open as Halo normally opens them.

Tested with romsets from [mamedev.org/roms](https://www.mamedev.org/roms/) (free for non-commercial use), unmodified: `gridlee` and `alienar` boot and play (coin, start, move, fire); `robby` is not in this FBNeo build's driver list and shows the unknown-romset page.

## Controls

| Action | Keyboard (1P) | Gamepad (standard mapping) |
|---|---|---|
| Move | W A S D | D-pad / left stick |
| Button 1 / 2 / 5 (bottom row) | J K L | A B RT |
| Button 3 / 4 / 6 (top row) | U I O | X Y RB |
| Start | Enter | Start |
| Insert coin | Space | Back / Select |
| Pause / resume | P | LB |
| Quick save / load | F2 / F4 | — |
| Mute | M | — |
| Fullscreen | toolbar button / double-click | — |

The labels follow FBNeo's own numbering on its default (classic) RetroPad layout, where every game takes Fire 1–6 = RetroPad B A Y X R L: **J K = Button 1 2** (most games use only these), **U I = Button 3 4, L = Button 5, O = Button 6**. One exception, noted in the help panel (⌨ toolbar button): six-button fighting games (FBNeo recognises them from the game's input list, or any CPS2 game with five or more buttons) are switched by FBNeo to a 3 + 3 layout — the game's buttons 1 2 3 on the top row U I O, 4 5 6 on the bottom row J K L. Same keys either way; only the in-game numbering differs. Coin = Select, Start = Start. EmulatorJS's own keyboard / gamepad handling is switched off; `app.js` owns every binding, so both the d-pad and the left stick move.

- **Pause**: P / pad LB / toolbar. The game also pauses when the iframe loses focus (typing in the Halo chat, another window) and resumes when it gets focus back; a pause you made yourself stays until you resume it.
- **Saves**: F2 / F4 (or the toolbar) keep one quick-save state per romset in the bundle, `saves/<set>.state` — it travels with the workspace. Switching editor tabs unmounts the game, so save first.
- **Display** (「画面」): *Pixel* (no filter), *Soft* (bicubic), *HD* (SABR edge smoothing), *CRT* (default; a light crt-easymode — scanlines + mask, no curvature). CRT is the default for a new bundle and for a `game.json` without `shader`; a shader `game.json` already names is kept. Stock easymode is dark and its RGB mask fringes small text on phones, so its own parameters are set lighter in the preset: `SCANLINE_STRENGTH` 0.6 (stock 1.0), `SCANLINE_BRIGHT_MIN` 0.5 (0.35), `MASK_STRENGTH` 0.15 (0.3). Applied live and stored in `game.json`. Picked for speed on WebGL 1: all four hold ~60 fps on a software renderer; crt-geom / crt-aperture / crt-lottes were too slow and left out.
- **Esc** is not bound — in a maximized Halo canvas Esc exits the maximized view.
- **Touch controls**: a **floating stick** on the left — touch anywhere in the left half of the game (below the top 56 px) and the stick centres under your finger; 8 directions with a deadzone, the knob clamps at the rim, and on release it fades back to a resting spot bottom-left. Buttons are EmulatorJS's on-screen ones, restyled: 2×3 grid bottom-right labelled 3 4 6 / 1 2 5, coin · start · pause bottom-centre. All ~40% opaque, nothing in the top 56 px (the host's controls). The stick follows only the touch that started it, so it and several buttons work at once. *Auto* (default) shows the controls on touch screens until a keyboard key or a gamepad is used, and brings them back on the next touch; the toolbar button cycles **Auto / On / Off** (remembered per browser).
- **Gamepads** need a secure context (HTTPS or localhost); a Bluetooth pad shows up after its first button press. The toolbar chip shows the connected pad.

## Install

- Agent: `/extension install arcade`
- Admin → Extensions → upload `arcade-2.0.0.zip` (from the GitHub release, ~8.5 MB)
- Manual: `./fetch-deps.sh && cp -r extensions/arcade ~/.halo/global/extensions/`

## Package

```bash
extensions/arcade/fetch-deps.sh          # npm EmulatorJS + FBNeo core (sha256-checked) → emulatorjs/ (~9 MB)
node scripts/pack.mjs extensions/arcade   # → dist/arcade-2.0.0.zip
```

`emulatorjs/` is gitignored and ships only inside the release zip. To upgrade, bump the versions + sha256 in `fetch-deps.sh` (and `NOTICE`), re-run, check that `emulatorjs-offline.patch` still applies, and re-test: pick a romset, a known one boots, an unknown one shows the unknown-romset page, the six buttons, gamepad, save / load into `saves/`, the stick + touch buttons, each display option, no network requests.

## Limits

- Single player (1P). No netplay, cheats, rewind, fast-forward, dip switches or service menu.
- Only romsets in **this** FBNeo build's driver list, in the matching romset version; no parent / BIOS zips (games that need a separate parent or BIOS zip, e.g. Neo Geo's `neogeo.zip`, can't be loaded alongside it).
- Vertical games are shown rotated as the core outputs them; there is no rotate option.
- Needs Halo with bundle extensions + the `pick` frame and the `fs-read` capability (`fs` scopes `workspace` / `system`).
- The core is the WebGL 1 build EmulatorJS 4.2.3 selects by default; the threaded builds need cross-origin isolation, which Halo does not send.

## Licenses

`LICENSE` (glue code, MIT) and `NOTICE`. EmulatorJS and RetroArch are **GPL-3.0** (`emulatorjs/LICENSE`); the display filters in `emulatorjs/src/shaders.js` are libretro shaders under the GPL (see `NOTICE`); FinalBurn Neo is under its own licence, included verbatim as `LICENSE-FBNEO.txt`: **no selling, leasing, renting or any other monetary profit, no donations**, source changes must be made public, and no distribution with ROM images without the legal right. FBNeo contains MAME code and is also subject to the MAME license.
