# drawio — draw.io editor

Halo Canvas preview extension: opens `.drawio` / `.dio` files in the **full draw.io editor** (editable, not a viewer) and saves them back to the workspace. Fully offline — the draw.io 32.0.2 web app is bundled, nothing is fetched from the network, no service worker is registered, and nothing is written outside the file you save.

- `priority: default` — double-clicking a `.drawio` file opens it directly.
- `capabilities: ["save"]` — edits mark the tab modified; **Save** in the Canvas header or **Ctrl/Cmd+S** inside the editor writes the file back.
- Saves are **uncompressed XML** (`<mxfile><diagram><mxGraphModel>…`), so the file stays readable and diffable, and agents can write/patch it by hand. Compressed diagrams in existing files are read fine and are written back uncompressed on the next save. The `host="…"` attribute draw.io adds is stripped.
- An **empty / zero-byte** file opens a blank diagram (create `foo.drawio`, open it, draw, save). A file that is not draw.io XML shows an error with *Open as Text* / Download.
- If the file changes on disk while you have no unsaved edits (an agent rewrote it) the open diagram is replaced; with unsaved edits Halo keeps yours and reports a conflict on the next save.
- Theme: the editor starts in Halo's current light/dark theme and follows it when the admin theme is switched.

Limits of the offline / sandboxed setup: no Google Drive / Dropbox / OneDrive / GitHub pickers, no server-side export (PDF goes through the print dialog), no *Insert ▸ Template* (draw.io hides the gallery when offline, so the templates are not shipped), no real-time collaboration. The iframe sandbox has no popups or downloads, so *File ▸ Export as* (PNG / SVG / PDF / XML) opens its dialog but cannot save a file, and links in diagrams do not open. Shape search, all shape libraries, MathJax (`$$…$$`), Mermaid / PlantUML / CSV import and the layout engines work locally.

## Install

- Agent: `/extension install drawio`
- Admin → Extensions → upload `drawio-1.0.0.zip` (from the GitHub release, ~22 MB)
- Manual: `./fetch-deps.sh && cp -r extensions/drawio ~/.halo/global/extensions/`

## Package

```bash
extensions/drawio/fetch-deps.sh          # downloads the pinned draw.war (sha256-checked) → webapp/, pruned (~57 MB)
node scripts/pack.mjs extensions/drawio   # → dist/drawio-1.0.0.zip (~22 MB)
```

`webapp/` is gitignored and ships only inside the release zip. To upgrade draw.io bump `DRAWIO_VERSION` + `WAR_SHA256` in `fetch-deps.sh` (and `NOTICE`), re-run, and re-test open / edit / save / dark theme.

## How it works

`index.html` is a thin host page: it speaks Halo's postMessage protocol v1 to the admin and draw.io's own embed protocol (`embed=1&proto=json`) to the editor running in a nested same-origin iframe (`webapp/index.html?embed=1&proto=json&offline=1&pwa=0&keepmodified=1&ui=kennedy&dark=0|1`).

| Halo → extension | effect |
| --- | --- |
| `init` | sets light/dark and creates the editor |
| `load` | `{action:'load', xml, autosave:1}` (first load, and again when the file changed on disk while clean) |
| `save-request` | `{action:'invokeAction', actionName:'save'}` → editor answers `{event:'save', xml}` → `save` frame; a 2 s fallback uses the last autosave |
| `saved` | clears dirty (`{action:'status', modified:false}`), unless more edits arrived while the save was in flight |
| `theme` | invokes draw.io's `lightMode` / `darkMode` action |

Licenses: see `LICENSE` (glue code, MIT), `LICENSE-APACHE-2.0` and `NOTICE` (draw.io and bundled libraries).
