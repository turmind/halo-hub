# ipynb — Jupyter Notebook viewer

Halo Canvas preview extension: opens `.ipynb` files the way Jupyter / GitHub show them. **Read-only** (no execution, no editing) and fully **offline** — marked, DOMPurify, highlight.js and KaTeX (with its fonts) are bundled, nothing is fetched from a CDN. The view refreshes when the file changes on disk (e.g. the agent edits the JSON); scroll position is kept.

## Install

- Agent: `/extension install ipynb`
- Admin → Extensions → upload `ipynb-1.0.0.zip` (from the GitHub release)
- Manual: `cp -r extensions/ipynb ~/.halo/global/extensions/`

Priority is `default`, so a `.ipynb` opens in this viewer; "Open as Text" in the preview header still shows the raw JSON.

## What it renders (nbformat 4)

- **Markdown cells** — marked (GFM) → DOMPurify. Raw HTML in the markdown is sanitized (no scripts / handlers / forms / iframes). Cell attachments (`attachment:img.png`) are shown; remote images are not loaded (offline) and appear as a `[image: …]` placeholder.
- **Math** — KaTeX: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, and `equation` / `align` / `gather` / `multline` / `eqnarray` environments (`multline` / `eqnarray` are mapped to `gather` / `align`). A `$` followed by whitespace or preceding a digit is not a delimiter, so "costs $5 and $10" stays text. Also used for `text/latex` outputs.
- **Code cells** — highlight.js (python, javascript, typescript, sql, bash, r, julia, json, yaml, c/c++, java, go, rust, … — the highlight.js "common" set plus julia); language from `kernelspec.language` / `language_info.name`, `%%bash`-style cell magics switch it. `In [n]:` / `Out [n]:` prompts.
- **Outputs** — `stream` (stderr tinted), `error` (traceback, ANSI colors converted; other escapes stripped), `execute_result` / `display_data` by priority `text/html` → `image/svg+xml` → `image/png|jpeg|gif|webp` → `text/markdown` → `text/latex` → `application/json` → `text/plain`.
  - `text/html` is sanitized and shown in a shadow root (pandas DataFrames look like tables; the output's own CSS stays scoped). HTML that sanitizes to nothing (plotly / bokeh bootstrap `<script>` only) falls back to the next representation.
  - Widgets (`application/vnd.jupyter.widget-view+json`) and unknown mime types show `[unsupported output: <mime>]` (with the `text/plain` repr when there is one).
- Long text outputs start collapsed (24 lines) with a "Show all · N lines" toggle.
- Header: kernel + language, cell counts. Light / dark follows the admin theme.
- Cells are rendered lazily (near the viewport first, the rest in idle slices), so a 50 MB notebook opens immediately and in-page find still works once it has filled in.

## Not supported

- nbformat 3 (`worksheets`) → the host shows an error with the `jupyter nbconvert` upgrade hint. Malformed JSON / not a notebook → same, with "Open as Text".
- Interactive output (ipywidgets, plotly/bokeh JS, `application/javascript`), execution, editing, cell collapsing from `metadata.collapsed`.
- `eqnarray` / `multline` are approximations (KaTeX has neither).

## Security

Notebooks are untrusted input and the frame shares the admin's origin (sandbox `allow-same-origin`), so there are two layers: everything that becomes HTML goes through DOMPurify (plus a hook that pins SVG `<use>` / `<image>` references to same-document ids / `data:` images and strips `url()` / `@import` from output CSS), and `index.html` carries a CSP (`script-src 'self'`, no inline scripts, `img-src 'self' data: blob:`, `connect-src` / `frame-src` / `form-action` / `object-src` all off).

## Package

```bash
node scripts/pack.mjs extensions/ipynb   # → dist/ipynb-1.0.0.zip
```

Third-party files in `vendor/` are committed; `./fetch-deps.sh` regenerates them from the pinned npm versions (KaTeX fonts: woff2 only, which every browser Halo supports reads). Licenses: see `LICENSE` and `NOTICE`.
