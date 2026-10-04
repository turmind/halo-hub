# excalidraw — Excalidraw Whiteboard

Halo Canvas preview extension: opens `.excalidraw` files in the official [Excalidraw](https://github.com/excalidraw/excalidraw) editor (`@excalidraw/excalidraw` 0.18.1 on React 19). Editable (`save` capability), fully offline — the editor, its UI translations and every font (including the Chinese hand-drawn Xiaolai font) are bundled, nothing is fetched from a CDN.

- Edit on the board; the tab shows the modified dot, **Save** (toolbar or Ctrl/Cmd+S) writes the `.excalidraw` JSON back to the file. Selecting / panning / zooming does not count as a change, and undoing back to the saved state clears the dot.
- Embedded images (`files` in the JSON) are kept; images can be inserted with the image tool.
- Theme follows the admin; the UI language follows the browser (`navigator.language`).
- If the file is rewritten on disk (e.g. by an agent) and the board has no unsaved edits, it reloads.
- An empty file opens as a blank board; a file that is not valid Excalidraw JSON shows "Open as Text".

## Install

- Agent: `/extension install excalidraw`
- Admin → Extensions → upload `excalidraw-1.0.0.zip` (from the GitHub release)

## Limitations (iframe sandbox: no downloads, popups, clipboard permission, network)

- Export to PNG/SVG, "Open" and "Save to…" are removed (they need downloads / file handles); the board is saved through Halo instead. Images are added with the image tool (file picker) or by paste / drag-and-drop.
- Collaboration, Excalidraw+ and library browsing (libraries.excalidraw.com) are unavailable offline and hidden. The shape library panel still works for the current session, but it is not persisted between openings.
- Web-embed elements and hyperlinks do not open: clicking a link shows the URL in a toast.
- AI features (text-to-diagram, diagram-to-code) need Excalidraw's backend and are disabled. Mermaid → Excalidraw works offline.
- Boards saved by this extension are standard Excalidraw files (`type: "excalidraw"`, version 2) and open in excalidraw.com / the VS Code plugin.

## Build

The committed sources are `src/main.jsx`, `index.html`, `package.json` + `package-lock.json`; the bundle (`app/`: `main.js`, lazy chunks, `index.css`, `fonts/`) is build output, gitignored and shipped only in the release zip.

```bash
cd extensions/excalidraw && ./build.sh        # npm ci + esbuild → app/   (needs network once)
cd ../.. && node scripts/pack.mjs extensions/excalidraw   # → dist/excalidraw-1.0.0.zip
```

Licenses: see `LICENSE` and `NOTICE`.
