#!/usr/bin/env bash
# Re-fetch the third-party runtime files bundled in this extension.
# Repo-maintenance script: excluded from the release zip (see scripts/pack.mjs).
# Run after bumping a version below, then commit the changed files.
#
#   model-viewer.min.js   <- @google/model-viewer dist/model-viewer.min.js (copied verbatim, license header kept;
#                            it already bundles three, lit, gainmap-js and an internal meshopt decoder)
#   decoders/draco/       <- three/examples/jsm/libs/draco/gltf/   (decoder only, no encoder)
#   decoders/basis/       <- three/examples/jsm/libs/basis/
#   decoders/meshopt_decoder.js <- meshoptimizer/meshopt_decoder.cjs (UMD; loaded as a classic <script>)
#   convert.min.js        <- esbuild bundle of src/convert.js: three's OBJLoader / STLLoader / GLTFExporter /
#                            BufferGeometryUtils (.obj / .stl -> in-memory GLB that model-viewer then displays)
#
# THREE_VERSION must equal the three that model-viewer.min.js bundles (r183 for model-viewer 4.3.1): the decoders
# and the loaders are taken from this exact release.
set -euo pipefail

MODEL_VIEWER_VERSION=4.3.1
THREE_VERSION=0.183.2
ESBUILD_VERSION=0.28.2
MESHOPTIMIZER_VERSION=1.0.1   # model-viewer 4.3.1 bundles "meshoptimizer 1.0"; 1.0.x decoders are byte-identical

cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

(cd "$tmp" && npm init -y >/dev/null \
  && npm i --no-audit --no-fund --ignore-scripts \
       "@google/model-viewer@${MODEL_VIEWER_VERSION}" "three@${THREE_VERSION}" \
       "esbuild@${ESBUILD_VERSION}" "meshoptimizer@${MESHOPTIMIZER_VERSION}")

nm="$tmp/node_modules"
rm -rf decoders
mkdir -p decoders/draco decoders/basis

cp "$nm/@google/model-viewer/dist/model-viewer.min.js" model-viewer.min.js
cp "$nm"/three/examples/jsm/libs/draco/gltf/{draco_decoder.js,draco_decoder.wasm,draco_wasm_wrapper.js} decoders/draco/
cp "$nm"/three/examples/jsm/libs/basis/{basis_transcoder.js,basis_transcoder.wasm} decoders/basis/
cp "$nm/meshoptimizer/meshopt_decoder.cjs" decoders/meshopt_decoder.js

cp src/convert.js "$tmp/convert.js"
(cd "$tmp" && ./node_modules/.bin/esbuild convert.js --bundle --minify --format=esm --target=es2020 \
  --legal-comments=inline --log-level=warning --outfile="$OLDPWD/convert.min.js")

echo "model-viewer ${MODEL_VIEWER_VERSION}, three $(node -p "require('$nm/three/package.json').version"), meshoptimizer ${MESHOPTIMIZER_VERSION}"
