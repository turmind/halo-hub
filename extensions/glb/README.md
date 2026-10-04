# glb — 3D Model Viewer

Halo Canvas preview extension: opens `.glb`, `.gltf`, `.obj` and `.stl` files with Google's `<model-viewer>`. Read-only, fully offline — model-viewer, the Draco / KTX2 (Basis) / Meshopt decoders and the OBJ / STL converter are bundled, nothing is fetched from a CDN.

| Format | How it is shown |
| --- | --- |
| `.glb` | straight into `<model-viewer>` |
| `.gltf` | straight into `<model-viewer>`; buffers / textures must be embedded (`data:` URIs) |
| `.obj` | converted in memory to GLB, neutral grey material, geometry only (no `.mtl` / textures); smooth normals are generated when the file has no `vn` lines |
| `.stl` | ASCII and binary, converted in memory to GLB, neutral grey material; Z-up (CAD / 3D-printing convention) is rotated to Y-up; smooth normals are generated with a 30° crease angle (flat facets above 400k triangles) |

## Limitations

The viewer only receives the bytes of the one file that was opened, never its siblings. A `.gltf` that references external files (`buffers[].uri` / `images[].uri` pointing at a `.bin` or texture next to it) therefore cannot be shown — the preview says which files are referenced; export as `.glb` or embed the resources. Likewise `.obj` materials (`.mtl`) and textures are not applied, and STL units are not interpreted (the camera auto-frames whatever the scale is).

## Install

- Agent: `/extension install glb`
- Admin → Extensions → upload `glb-1.1.0.zip` (from the GitHub release)
- Manual: `cp -r extensions/glb ~/.halo/global/extensions/`

## Package

```bash
node scripts/pack.mjs extensions/glb   # → dist/glb-1.1.0.zip
```

Third-party files (`model-viewer.min.js`, `decoders/`) are committed; `./fetch-deps.sh` regenerates them from the pinned npm versions. `convert.min.js` is an esbuild bundle of `src/convert.js` (three's `OBJLoader` / `STLLoader` / `GLTFExporter` / `BufferGeometryUtils`), also rebuilt by `./fetch-deps.sh`. Licenses: see `LICENSE` and `NOTICE`.
