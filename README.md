# halo-hub

Installable add-ons for [Halo](https://github.com/turmind/halo-agent), kept out of the main app so the core package stays small.

## Layout

```
extensions/<id>/    Canvas preview extensions (open file types the core app does not ship, e.g. .drawio, .glb)
skills/<id>/        Skills (SKILL.md + resources)
workspaces/<id>/    Shareable workspace bundles (.halo/ config)
dist/               Build output — packaged zips, not committed
```

- One directory per item. The directory name is the item's id.
- Each item is packaged as a standalone zip. Zips are published as GitHub release assets, not committed to the repo.

## Catalog

**Extensions** (`extensions/<id>/`, release tag `<id>-v<version>`)

| id | Opens | Edit | Notes |
|---|---|---|---|
| `glb` | `.glb` `.gltf` `.obj` `.stl` | — | 3D viewer (model-viewer); `.gltf` must be self-contained |
| `drawio` | `.drawio` `.dio` | ✓ | Offline draw.io editor (~22 MB zip); release-zip install only |
| `excalidraw` | `.excalidraw` | ✓ | Offline Excalidraw whiteboard (~16 MB zip); release-zip install only |
| `ipynb` | `.ipynb` | — | Jupyter notebook viewer (markdown, math, outputs) |

**Skills** (`skills/<id>/`, release tag `skill-<id>-v<version>`)

| id | What |
|---|---|
| `web-search` | Real-time web search — fast (Nova grounding) / deep (GPT-5.6 web_search on Bedrock Mantle); needs AWS credentials |

**Workspaces** (`workspaces/<id>/`, release tag `ws-<id>-v<version>`)

| id | What |
|---|---|
| `secretary` | Front-desk workspace that routes requests to department workspaces on the same server via relay tools |

Until `/skill install` and `/workspace import` ship, copy skills into `<workspace>/.halo/skills/` and workspace bundles' `.halo/` into the project root by hand (see each item's README).

## Install

Extensions install globally (under `~/.halo/global/`). Three ways:

- **Agent**: `/extension install <id>` — downloads the latest `<id>-v*` release zip from this repo.
- **Admin**: Extensions panel → upload the `<id>-<version>.zip` from a GitHub release.
- **Manual**: unzip a release zip into `~/.halo/global/extensions/<id>/`. For extensions whose runtime files are committed (`glb`, `ipynb`), `cp -r extensions/<id> ~/.halo/global/extensions/` also works; `drawio` and `excalidraw` need their `fetch-deps.sh` / `build.sh` run first, so use the release zip.

## Publishing

One tag = one release = one zip, tagged `<id>-v<version>`:

```bash
# bump "version" in extensions/<id>/halo-extension.json, commit, then:
node scripts/pack.mjs extensions/<id>          # → dist/<id>-<version>.zip
gh release create <id>-v<version> dist/<id>-<version>.zip --title "<id> v<version>"
```

`pack.mjs` needs only Node and the system `zip`; it checks that the manifest `id` matches the directory name, the `version` is semver, and `entry` exists. Repo-maintenance files (`fetch-deps.sh`, `build.sh`) are left out of the zip.
