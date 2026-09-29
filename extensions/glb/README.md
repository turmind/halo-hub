# glb — GLB Viewer

Halo Canvas preview extension: opens `.glb` files with Google's `<model-viewer>`. Read-only, fully offline — model-viewer and the Draco / KTX2 (Basis) / Meshopt decoders are bundled, nothing is fetched from a CDN.

## Install

- Agent: `/extension install glb`
- Admin → Extensions → upload `glb-1.0.0.zip` (from the GitHub release)
- Manual: `cp -r extensions/glb ~/.halo/global/extensions/`

## Package

```bash
node scripts/pack.mjs extensions/glb   # → dist/glb-1.0.0.zip
```

Third-party files (`model-viewer.min.js`, `decoders/`) are committed; `./fetch-deps.sh` regenerates them from the pinned npm versions. Licenses: see `LICENSE` and `NOTICE`.
