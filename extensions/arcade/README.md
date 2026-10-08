# arcade — arcade emulator (FinalBurn Neo)

Halo Canvas preview extension: plays **arcade romsets** right in the Canvas, with [EmulatorJS](https://emulatorjs.org) 4.2.3 and the FinalBurn Neo (FBNeo) core. Fully offline: the emulator and core are bundled (~8.5 MB zip), nothing is fetched from the network. **No ROMs are included** — open romsets you have the right to use.

- Opens `.zip` romsets **as distributed**: FBNeo finds the game by the zip's file name (`gridlee.zip` = romset `gridlee`) and checks the chips inside itself, so don't rename, unpack or repack the zip. `priority: default`.
- A zip FBNeo doesn't know (a name missing from this FBNeo build's game list, missing / wrong-version files) shows "FinalBurn Neo doesn't know the romset …" with the archive's file list instead of booting.
- A zip that clearly isn't a romset (empty, unreadable, or holding a console cartridge / disc image) shows "not a ROM this extension can open" — use **Open with** in the Canvas header to pick another viewer.
- Read-only: nothing is written to the workspace.

Tested with romsets from [mamedev.org/roms](https://www.mamedev.org/roms/) (free for non-commercial use), unmodified: `gridlee` and `alienar` boot and play (coin, start, move, fire); `robby` is not in this FBNeo build's driver list and shows the unknown-romset page.

## Controls

| Action | Keyboard (1P) | Gamepad (standard mapping) |
|---|---|---|
| Move | W A S D | D-pad / left stick |
| Light / medium / heavy punch | U I O | X Y RB |
| Light / medium / heavy kick | J K L | A B RT |
| Start | Enter | Start |
| Insert coin | Space | Back / Select |
| Pause / resume | P | LB |
| Quick save / load | F2 / F4 | — |
| Mute | M | — |
| Fullscreen | toolbar button / double-click | — |

How the keys reach the core: FBNeo's classic RetroPad layout. 6-button fighters (Street Fighter style) take punch = Y X L and kick = B A R (U I O / J K L above). Every other game takes Fire 1–6 = B A Y X R L, which with the same keys is **J K = Fire 1 2, U I = Fire 3 4, L = Fire 5, O = Fire 6** — the help panel (⌨ toolbar button) shows both names. Coin = Select, Start = Start. EmulatorJS's own keyboard / gamepad handling is switched off; `app.js` owns every binding, so both the d-pad and the left stick move.

- **Pause**: P / pad LB / toolbar. The game also pauses when the iframe loses focus (typing in the Halo chat, another window) and resumes when it gets focus back; a pause you made yourself stays until you resume it.
- **Saves**: F2 / F4 (or the toolbar) keep one save state per romset in this browser's IndexedDB (the admin origin's — desktop app and web admin don't share). Switching editor tabs unmounts the game, so save first.
- **Esc** is not bound — in a maximized Halo canvas Esc exits the maximized view.
- **Touch controls**: EmulatorJS's on-screen gamepad, restyled — d-pad bottom-left, 2×3 punch / kick grid bottom-right, coin · start · pause bottom-centre, ~40% opaque, nothing in the top 56 px. *Auto* (default) shows it on touch screens until a keyboard key or a gamepad is used, and brings it back on the next touch; the toolbar button cycles **Auto / On / Off** (remembered per browser). Several buttons can be held at once.
- **Gamepads** need a secure context (HTTPS or localhost); a Bluetooth pad shows up after its first button press. The toolbar chip shows the connected pad.

## `.zip` and other extensions

Halo routes a file extension to the newest-installed `default` extension. `.zip` is also claimed by `megadrive` (console ROMs in a zip), so with both installed, every zip opens in whichever was installed last, and the other one is in **Open with**. Each one shows a "not a ROM this extension can open" page for zips it can't use, so the fix is one click away. Halo's iframe protocol has no "I can't open this, try the next viewer" frame yet.

## Install

- Agent: `/extension install arcade`
- Admin → Extensions → upload `arcade-1.0.0.zip` (from the GitHub release, ~8.5 MB)
- Manual: `./fetch-deps.sh && cp -r extensions/arcade ~/.halo/global/extensions/`

## Package

```bash
extensions/arcade/fetch-deps.sh          # npm EmulatorJS + FBNeo core (sha256-checked) → emulatorjs/ (~9 MB)
node scripts/pack.mjs extensions/arcade   # → dist/arcade-1.0.0.zip
```

`emulatorjs/` is gitignored and ships only inside the release zip. To upgrade, bump the versions + sha256 in `fetch-deps.sh` (and `NOTICE`), re-run, check that `emulatorjs-offline.patch` still applies, and re-test: a known romset boots, an unknown one shows the unknown-romset page, the six buttons, gamepad, save / load, touch controls, no network requests.

## Limits

- Single player (1P). No netplay, cheats, shaders, rewind, fast-forward, dip switches or service menu.
- Only romsets in **this** FBNeo build's driver list, in the matching romset version; no parent / BIOS zips (games that need a separate parent or BIOS zip, e.g. Neo Geo's `neogeo.zip`, can't load it from the workspace).
- Vertical games are shown rotated as the core outputs them; there is no rotate option.
- Saves are browser-local; not written into the workspace.
- The core is the WebGL 1 build EmulatorJS 4.2.3 selects by default; the threaded builds need cross-origin isolation, which Halo does not send.

## Licenses

`LICENSE` (glue code, MIT) and `NOTICE`. EmulatorJS and RetroArch are **GPL-3.0** (`emulatorjs/LICENSE`); FinalBurn Neo is under its own licence, included verbatim as `LICENSE-FBNEO.txt`: **no selling, leasing, renting or any other monetary profit, no donations**, source changes must be made public, and no distribution with ROM images without the legal right. FBNeo contains MAME code and is also subject to the MAME license.
