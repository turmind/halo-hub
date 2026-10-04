#!/bin/sh
# Rebuilds app/ (gitignored, shipped in the release zip) from the pinned npm versions in package-lock.json.
# Needs network for `npm ci`; the resulting extension itself is fully offline.
set -eu
cd "$(dirname "$0")"
npm ci --no-audit --no-fund
rm -rf app
node_modules/.bin/esbuild src/main.jsx --bundle --splitting --format=esm --minify --target=es2022 \
  --jsx=automatic --define:process.env.NODE_ENV='"production"' \
  --entry-names=main --chunk-names='chunks/[name]-[hash]' --outdir=app --legal-comments=none
# Fonts are loaded lazily at runtime from EXCALIDRAW_ASSET_PATH (see index.html) and by index.css (url("./fonts/…")).
cp -R node_modules/@excalidraw/excalidraw/dist/prod/fonts app/fonts
cp node_modules/@excalidraw/excalidraw/dist/prod/index.css app/index.css
