# ipynb — Jupyter Notebook

Halo Canvas preview extension: opens `.ipynb` files the way Jupyter / GitHub show them, lets you **edit and save** the cells, and — on a Halo server that has Jupyter — **run** them on a kernel. Rendering and editing are fully **offline**: marked, DOMPurify, highlight.js, KaTeX (with its fonts) and CodeMirror 6 are bundled, nothing is fetched from a CDN. The view refreshes when the file changes on disk (e.g. the agent edits the JSON) while there are no unsaved edits; scroll position is kept.

| | Halo 1.6.0 | Halo ≥ 1.6.1 |
|---|---|---|
| View, edit, save | ✓ | ✓ |
| Run cells | — (no run controls) | ✓ when the server has Jupyter |

## Install

- Agent: `/extension install ipynb`
- Admin → Extensions → upload `ipynb-2.0.0.zip` (from the GitHub release)
- Manual: `cp -r extensions/ipynb ~/.halo/global/extensions/`

Priority is `default`, so a `.ipynb` opens in this extension; "Open as Text" in the preview header still shows the raw JSON.

## Editing

- **Click a cell** to edit it (CodeMirror, only for that cell — the others stay plain highlighted views, so big notebooks stay fast). **Esc** leaves the editor; a markdown cell renders again on **Shift+Enter** or when focus moves elsewhere in the notebook.
- **Selected cell toolbar**: ▶ run (when a kernel is available), cell type (Code / Markdown / Raw), ↑ / ↓ move, +↑ / +↓ add a cell above / below, 🗑 delete.
- **Keys** — in the editor: Shift+Enter = run / render and go to the next cell (adds one at the end), Ctrl/Cmd+Enter = run / render and stay, Esc = stop editing. On a selected cell (not editing): Enter = edit, Shift+Enter / Ctrl+Enter as above. Ctrl/Cmd+S saves anywhere in the notebook.
- **Save**: the header **Save** button or Ctrl/Cmd+S. The tab shows the unsaved dot while the notebook differs from the file; editing a cell back to exactly what it was clears it again (exact for notebooks up to 4 MB; bigger ones stay marked until saved). An untouched notebook is never rewritten.
- **File format**: written like Jupyter does — nbformat 4, one-space indent, non-ASCII kept as is, trailing newline. Key order, unknown fields, cell ids and number spellings (`1.0`, `1e-05`) are preserved, so a notebook Jupyter wrote, edited and edited back, saves byte-identical. Files that were not written by Jupyter (compact JSON, other indents) are normalized to that format on the first save. New cells get an 8-hex `id` when the notebook is nbformat ≥ 4.5 and none on older minors. An empty file opens as a new notebook ("+ Add a cell").

## Running cells (Halo ≥ 1.6.1)

The extension talks to the kernel through the Halo server's Jupyter proxy (`/api/jupyter`, admin cookie, same origin). It never installs anything — not in the browser, not on the server.

**Server setup** (once, on the machine Halo runs on, as the Halo service user):

```bash
pip install jupyter_server ipykernel      # into any Python env, e.g. python3 -m venv ~/.venvs/jupyter first
```

If `jupyter` is not on the service's PATH, set its full path in **Settings → `general.jupyter.path`** (e.g. `/home/me/.venvs/jupyter/bin/jupyter`). `general.jupyter.enabled` (default on) switches notebook execution off for the whole server; with it off the run controls are not shown at all. Packages your notebooks import (numpy, pandas, matplotlib, …) go into the same env as ipykernel.

**In the notebook header**: kernel picker (the notebook's own `kernelspec` when the server has it, else the server default; picking another one writes `metadata.kernelspec`), status badge (no kernel / starting / idle / busy / restarting / dead / shut down), **Run all**, **Interrupt**, **Restart**.

- The kernel starts on the first run, in the notebook's folder (`os.getcwd()` = that folder), and shuts down when the tab closes (the server also stops it 60 s after its last connection drops, and stops kernels idle for an hour).
- Cells run in order through a queue; `In [*]` marks queued / running cells. An error stops the rest of the queue (like Jupyter's Run all).
- Outputs (streams, errors with ANSI colors, rich `display_data` / `execute_result`, `clear_output`, display updates) are stored in nbformat shape and make the notebook dirty — save to keep them.
- A dropped connection is retried 3 times (1 / 2 / 4 s); after that the badge shows dead and **Restart** starts it again. A kernel the server shut down (idle) shows "shut down"; the next run or Restart starts a new one.
- **Jupyter missing**: when the server reports Jupyter unavailable (or a kernel start is refused for that reason), the header shows a short notice with the server's install hint (`pip install jupyter_server ipykernel`), the `general.jupyter.path` setting, and a **Check again** button — no automatic retries. Editing and saving work as usual.

**Permissions**: kernels run as the Halo service user, outside Halo's sandbox — the same reach as the admin terminal. Only admin-cookie sessions can start them; anyone who can open the admin can run code with it, so leave `general.jupyter.enabled` off on servers where that is not wanted.

## What it renders (nbformat 4)

- **Markdown cells** — marked (GFM) → DOMPurify. Raw HTML in the markdown is sanitized (no scripts / handlers / forms / iframes). Cell attachments (`attachment:img.png`) are shown; remote images are not loaded (offline) and appear as a `[image: …]` placeholder.
- **Math** — KaTeX: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, and `equation` / `align` / `gather` / `multline` / `eqnarray` environments (`multline` / `eqnarray` are mapped to `gather` / `align`). A `$` followed by whitespace or preceding a digit is not a delimiter, so "costs $5 and $10" stays text. Also used for `text/latex` outputs.
- **Code cells** — highlight.js (python, javascript, typescript, sql, bash, r, julia, json, yaml, c/c++, java, go, rust, … — the highlight.js "common" set plus julia); language from `kernelspec.language` / `language_info.name`, `%%bash`-style cell magics switch it. The editor highlights python, markdown, javascript / typescript, sql, r, julia and shell. `In [n]:` / `Out [n]:` prompts.
- **Outputs** — `stream` (stderr tinted), `error` (traceback, ANSI colors converted; other escapes stripped), `execute_result` / `display_data` by priority `text/html` → `image/svg+xml` → `image/png|jpeg|gif|webp` → `text/markdown` → `text/latex` → `application/json` → `text/plain`.
  - `text/html` is sanitized and shown in a shadow root (pandas DataFrames look like tables; the output's own CSS stays scoped). HTML that sanitizes to nothing (plotly / bokeh bootstrap `<script>` only) falls back to the next representation.
  - Widgets (`application/vnd.jupyter.widget-view+json`) and unknown mime types show `[unsupported output: <mime>]` (with the `text/plain` repr when there is one).
- Long text outputs start collapsed (24 lines) with a "Show all · N lines" toggle.
- Header: kernel + language, cell counts. Light / dark follows the admin theme; the interface follows the admin language (English / 中文).
- Cells are rendered lazily (near the viewport first, the rest in idle slices), so a 50 MB notebook opens immediately and in-page find still works once it has filled in.

## Not supported

- nbformat 3 (`worksheets`) → the host shows an error with the `jupyter nbconvert` upgrade hint. Malformed JSON / not a notebook → same, with "Open as Text".
- Interactive output (ipywidgets, plotly/bokeh JS, `application/javascript`), `input()` (stdin), comms, cell collapsing from `metadata.collapsed`, undo across cells (undo works inside the cell being edited).
- `eqnarray` / `multline` are approximations (KaTeX has neither).

## Security

Notebooks are untrusted input and the frame shares the admin's origin (sandbox `allow-same-origin`), so there are two layers: everything that becomes HTML goes through DOMPurify (plus a hook that pins SVG `<use>` / `<image>` references to same-document ids / `data:` images and strips `url()` / `@import` from output CSS), and `index.html` carries a CSP (`script-src 'self'`, no inline scripts, `img-src 'self' data: blob:`, `connect-src 'self'` — only the Halo server's own `/api/jupyter`, `frame-src` / `form-action` / `object-src` off). Kernel output is rendered through the same sanitizer as saved output.

## Package

```bash
node scripts/pack.mjs extensions/ipynb   # → dist/ipynb-2.0.0.zip
```

Third-party files in `vendor/` are committed; `./fetch-deps.sh` regenerates them from the pinned npm versions (KaTeX fonts: woff2 only, which every browser Halo supports reads; `vendor/codemirror.js` is built from `src/codemirror.js` with esbuild). `src/` and `fetch-deps.sh` are not in the release zip. Licenses: see `LICENSE` and `NOTICE`.
