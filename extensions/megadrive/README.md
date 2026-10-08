# megadrive — Mega Drive / Genesis emulator

Halo Canvas preview extension: plays **Sega Mega Drive / Genesis** ROMs — and Master System / Game Gear — right in the Canvas, with [EmulatorJS](https://emulatorjs.org) 4.2.3 and the Genesis Plus GX core. Fully offline: the emulator and core are bundled (~2 MB), nothing is fetched from the network. **No ROMs are included** — open your own.

- Opens `.gen` `.smd` `.sms` `.gg`, and `.zip` archives that hold a ROM (`.md` `.gen` `.smd` `.bin` `.sms` `.gg` `.32x` inside). `priority: default` — double-clicking opens it directly.
- A bare **`.md`** file is not claimed (Halo opens `.md` as Markdown): zip it, or rename it to `.gen`. A lone **`.bin`** is not claimed either; inside a zip it counts only as the zip's single `.bin` of at least 128 KiB.
- A `.zip` without a console ROM shows "not a ROM this extension can open" with the archive's file list — use **Open with** in the Canvas header to pick another viewer.
- Read-only: nothing is written to the workspace.

## Controls

| Action | Keyboard (1P) | Gamepad (standard mapping) |
|---|---|---|
| Move | W A S D | D-pad / left stick |
| Light / medium / heavy punch (X Y Z) | U I O | X Y RB |
| Light / medium / heavy kick (A B C) | J K L | A B RT |
| Start | Enter | Start |
| Coin / Mode | Space | Back / Select |
| Pause / resume | P | LB |
| Quick save / load | F2 / F4 | — |
| Mute | M | — |
| Fullscreen | toolbar button / double-click | — |

Master System / Game Gear use buttons 1 / 2 = **J / K** (pad A / B). The punch / kick labels follow Street Fighter II; the six buttons are the Genesis 6-button pad (top row X Y Z, bottom row A B C), which Genesis Plus GX selects for games that support it (3-button games use A B C only).

How the keys reach the core (libretro RetroPad ids, Genesis Plus GX's pad mapping): X→L, Y→X, Z→R, A→Y, B→B, C→A, Mode→Select, Start→Start. EmulatorJS's own keyboard / gamepad handling is switched off; `app.js` owns every binding, so both the d-pad and the left stick move, and the help panel (⌨ toolbar button) is always what is actually bound.

- **Pause**: P / pad LB / toolbar. The game also pauses when the iframe loses focus (typing in the Halo chat, another window) and resumes when it gets focus back; a pause you made yourself stays until you resume it.
- **Saves**: F2 / F4 (or the toolbar) keep one save state per ROM in this browser's IndexedDB (the admin origin's — desktop app and web admin don't share). Switching editor tabs unmounts the game, so save first.
- **Esc** is not bound — in a maximized Halo canvas Esc exits the maximized view.
- **Touch controls**: EmulatorJS's on-screen gamepad, restyled — d-pad bottom-left, 2×3 punch / kick grid bottom-right, coin · start · pause bottom-centre, ~40% opaque, nothing in the top 56 px. *Auto* (default) shows it on touch screens until a keyboard key or a gamepad is used, and brings it back on the next touch; the toolbar button cycles **Auto / On / Off** (remembered per browser). Several buttons can be held at once.
- **Gamepads** need a secure context (HTTPS or localhost); a Bluetooth pad shows up after its first button press. The toolbar chip shows the connected pad.

## Install

- Agent: `/extension install megadrive`
- Admin → Extensions → upload `megadrive-1.0.0.zip` (from the GitHub release, ~2 MB)
- Manual: `./fetch-deps.sh && cp -r extensions/megadrive ~/.halo/global/extensions/`

## Package

```bash
extensions/megadrive/fetch-deps.sh          # npm EmulatorJS + Genesis Plus GX core (sha256-checked) → emulatorjs/ (~2 MB)
node scripts/pack.mjs extensions/megadrive   # → dist/megadrive-1.0.0.zip
```

`emulatorjs/` is gitignored and ships only inside the release zip. To upgrade, bump the versions + sha256 in `fetch-deps.sh` (and `NOTICE`), re-run, check that `emulatorjs-offline.patch` still applies, and re-test: boot, the six buttons, gamepad, save / load, touch controls, no network requests.

## Limits

- Single player (1P). No netplay, cheats, shaders, rewind or fast-forward.
- Sega CD / 32X / SG-1000 / Pico are not offered (32X needs another core; CD needs BIOS and disc images).
- Saves are browser-local; not written into the workspace.
- The core is the WebGL 1 build EmulatorJS 4.2.3 selects by default; the threaded builds need cross-origin isolation, which Halo does not send.

## Licenses

`LICENSE` (glue code, MIT) and `NOTICE`. EmulatorJS is **GPL-3.0** (`emulatorjs/LICENSE`); the Genesis Plus GX core is under its own **non-commercial** license (`LICENSE-GENESIS-PLUS-GX.txt`) — this extension may not be sold or used in a commercial product or activity.
