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

## Install

Extensions install globally (under `~/.halo/global/`). Three ways:

- **Agent**: `/extension install <id>` — downloads the latest `<id>-v*` release zip from this repo.
- **Admin**: Extensions panel → upload the `<id>-<version>.zip` from a GitHub release.
- **Manual**: `cp -r extensions/<id> ~/.halo/global/extensions/` (the directory *is* the installed form — no build step).

## Publishing

One tag = one release = one zip, tagged `<id>-v<version>`:

```bash
# bump "version" in extensions/<id>/halo-extension.json, commit, then:
node scripts/pack.mjs extensions/<id>          # → dist/<id>-<version>.zip
gh release create <id>-v<version> dist/<id>-<version>.zip --title "<id> v<version>"
```

`pack.mjs` needs only Node and the system `zip`; it checks that the manifest `id` matches the directory name, the `version` is semver, and `entry` exists. Repo-maintenance files (`fetch-deps.sh`, `build.sh`) are left out of the zip.
