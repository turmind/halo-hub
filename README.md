# halo-hub

Installable add-ons for [Halo](https://github.com/turmind/halo-agent), kept out of the main app so the core package stays small.

## Layout

```
extensions/<id>/    Canvas preview extensions (open file types the core app does not ship, e.g. .drawio, .glb, or add an activity-bar entry / chat-bar button)
models/<id>.yaml    Model provider configs (one yaml per provider, released together)
skills/<id>/        Skills (SKILL.md + resources)
workspaces/<id>/    Shareable workspace bundles (.halo/ config)
dist/               Build output — packaged zips, not committed
```

- One directory per item. The directory name is the item's id.
- Each item is packaged as a standalone zip. Zips are published as GitHub release assets, not committed to the repo.
- An extension documents itself: `README.md` at its root (what it opens, requirements, usage), `DESIGN.md` for internals when worth it. Both ship in the zip; once installed, Halo's built-in `halo` skill points agents at `~/.halo/global/extensions/<id>/README.md`. Instructions an agent should follow go in an extension skill, `extensions/<id>/skills/<id or id-…>/SKILL.md`, which users enable per agent. Nothing is injected into prompts automatically.

## Catalog

**Extensions** (`extensions/<id>/`, release tag `<id>-v<version>`)

| id | Opens | Edit | Notes |
|---|---|---|---|
| `glb` | `.glb` `.gltf` `.obj` `.stl` | — | 3D viewer (model-viewer); `.gltf` must be self-contained |
| `drawio` | `.drawio` `.dio` | ✓ | Offline draw.io editor (~22 MB zip); release-zip install only |
| `excalidraw` | `.excalidraw` | ✓ | Offline Excalidraw whiteboard (~16 MB zip); release-zip install only |
| `ipynb` | `.ipynb` | ✓ | Jupyter notebooks: render (markdown, math, outputs), edit and save cells offline; run them on a Jupyter kernel through the Halo server (Halo ≥ 1.6.1 with `pip install jupyter_server ipykernel` on the server; editing works on 1.6.0) |
| `htrans` | `.htrans` (folder) | ✓ | Meeting recorder: mic + system sound, live Amazon Transcribe captions, timed screenshots; needs the server's transcribe proxy + AWS credentials |
| `megadrive` | `.mega` (folder) | — | Offline Mega Drive / Genesis (+ Master System / Game Gear) emulator, EmulatorJS + Genesis Plus GX (~1.5 MB zip). The folder holds `game.json` (which ROM, anywhere on the machine — `.zip` `.7z` `.md` `.gen` `.smd` `.bin` `.sms` `.gg`, read in place, never copied — and the display filter) and `saves/`; keyboard, gamepad, touch stick; two players (keyboard + gamepad or two gamepads); non-commercial core license, no ROMs; release-zip install only |
| `arcade` | `.arcade` (folder) | — | Offline arcade emulator, EmulatorJS + FinalBurn Neo (~8.5 MB zip). The folder holds `game.json` (which romset, anywhere on the machine — an unmodified `.zip` named after the set, read in place, never copied; parent / BIOS zips such as `neogeo.zip` are picked up from the same folder — and the display filter) and `saves/`; keyboard, gamepad, touch stick; two players (keyboard + gamepad or two gamepads); FBNeo licence forbids any commercial use, no ROMs; release-zip install only |
| `halo-city` | — (activity-bar entry) | — | Live pixel city of the server; needs Halo ≥ 1.6.5 |
| `voice-input` | — (chat-bar button) | — | Dictation into the chat box, inserted at the cursor and never sent. Transcribed on your own Halo server (SenseVoice-Small, FunASR Model License; zh / en / yue / ja / ko). Needs Halo ≥ 1.6.5; the server downloads ~240 MB of model files on first use |

**Models** (`models/<id>.yaml`, release tag `models-v<YYYY.MM.DD>`)

Model provider configs — the same yamls Halo bundles in `packages/server/templates/models/`, published here so a new model or a changed provider endpoint reaches users without a Halo release. All providers ship in one zip, `models-<YYYY.MM.DD>.zip`.

- **Install / update**: `/extension models` (or tell the agent "update the model list"). It downloads the newest `models-v*` release and installs each yaml into `~/.halo/global/models.d/`; a running server picks it up without a restart. If a provider is new, its `defaultEndpoint` / `endpointPresets` change, or a model's `endpoints:` gains a URL the provider didn't use anywhere yet, the agent lists the changes and asks before applying. Only https GitHub / Gitea / Forgejo / GitLab hubs with releases are accepted.
- **Needs Halo ≥ 1.6.1**: 1.6.1 keeps existing agents on their effective verbosity / context, sends Doubao 2.1 Pro images, can switch Hunyuan thinking off, and honours per-model `endpoints:`. On 1.6.0, Mantle agents without `model.verbosity` move from low to medium, Haiku 5.5 agents without a `context:` block drop to a 100K window, Doubao images are dropped, and Hunyuan keeps thinking on.
- **Revision rule**: every yaml carries `revision: YYYYMMDDNN` (an integer; `NN` = that day's sequence). Per provider id Halo uses the copy with the higher revision, and the hub copy on a tie. **Bump `revision` on every edit**, whether you edit the bundled copy in halo-agent or the hub copy here, or the edit loses to the other copy.
- Halo refuses a provider whose `runtime:` it doesn't know (needs a newer Halo), one without `revision`, and one whose `secrets[].default` is anything but empty or an `<<ENV_NAME>>` placeholder. Never put credential values in these files.

| ids | Revision |
|---|---|
| `minimax` `zhipu` | `2026101002` |
| `kimi` | `2026101004` |
| `anthropic` `aws-bedrock-claude-invoke` `aws-bedrock-mantle` `aws-bedrock-openai` `doubao` `openai` | `2026101005` |
| `deepseek` `hunyuan` `qwen` | `2026101101` |
| `gemini` | `2026101201` |
| `mimo-token-plan-china` | `2026101401` |

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
- **Manual**: unzip a release zip into `~/.halo/global/extensions/<id>/`. For extensions whose runtime files are committed (`glb`, `ipynb`, `halo-city`), `cp -r extensions/<id> ~/.halo/global/extensions/` also works; `drawio` and `excalidraw` need their `fetch-deps.sh` / `build.sh` run first, so use the release zip.

## Publishing

One tag = one release = one zip, tagged `<id>-v<version>`:

```bash
# bump "version" in extensions/<id>/halo-extension.json, commit, then:
node scripts/pack.mjs extensions/<id>          # → dist/<id>-<version>.zip
gh release create <id>-v<version> dist/<id>-<version>.zip --title "<id> v<version>"
```

`pack.mjs` needs only Node and the system `zip`; it checks that the manifest `id` matches the directory name, the `version` is semver, `entry` exists, and the `activity` (activity-bar entry) and `chatbar` (chat-input toolbar button; `height` 80–480, default 160) blocks are well-formed, their `icon` must exist — the same rules and messages as the host's registry. Repo-maintenance files (`fetch-deps.sh`, `build.sh`) are left out of the zip.

Model configs are released together, tagged with the UTC date:

```bash
# edit models/<id>.yaml, bump its revision (YYYYMMDDNN), commit, then:
node scripts/pack.mjs models                   # → dist/models-<YYYY.MM.DD>.zip (today, UTC)
gh release create models-v<YYYY.MM.DD> dist/models-<YYYY.MM.DD>.zip --title "models v<YYYY.MM.DD>"
```

For models, `pack.mjs` checks that each file's `id` matches its name, `revision` is a 10-digit integer, and no `secrets` default holds a value. A second release on the same day needs a distinct tag (e.g. `models-v2026.10.05.2`); rename the zip to match.
