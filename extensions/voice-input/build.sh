#!/bin/sh
# Rebuilds backend/ (gitignored, shipped in the release zip): src/backend/*.ts → backend/index.cjs (esbuild, ws inlined),
# plus sherpa-onnx-node and the native sherpa-onnx-<platform>-<arch> package npm picked for THIS machine.
# One zip per platform until Halo grows per-platform packages — run it on (or for) the target platform.
set -eu
cd "$(dirname "$0")"
npm ci --no-audit --no-fund
node_modules/.bin/tsc -p tsconfig.json
rm -rf backend
node_modules/.bin/esbuild src/backend/main.ts --bundle --platform=node --format=cjs --target=node22 \
  --external:sherpa-onnx-node --outfile=backend/index.cjs --legal-comments=none
mkdir -p backend/node_modules
cp -R node_modules/sherpa-onnx-node backend/node_modules/
for p in node_modules/sherpa-onnx-*-*; do [ -d "$p" ] && cp -R "$p" backend/node_modules/; done
ls backend/node_modules
