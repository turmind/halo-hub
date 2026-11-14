#!/bin/sh
# usage: shared/stt-backend/build.sh <extension dir> [<os>-<arch>]
#
# Builds the on-device speech backend into <extension dir>/backend/ (gitignored, shipped in the release zip):
#   backend/index.cjs                         src/*.ts bundled by esbuild (ws inlined)
#   backend/node_modules/sherpa-onnx-node/    the pure-JS loader
#   backend/node_modules/sherpa-onnx-<plat>/  the native addon + onnxruntime for ONE platform
# <os>-<arch> is npm's native-package naming (linux-x64, linux-arm64, darwin-arm64, darwin-x64, win-x64); default = this
# machine. The native package is fetched with `npm pack`, so any platform builds on any machine (no compiler involved).
# One zip per platform: scripts/pack.mjs <ext> <os>-<arch> packs what this left in backend/.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
ext=$(cd "${1:?usage: build.sh <extension dir> [<os>-<arch>]}" && pwd)
plat=${2:-$(node -p '(process.platform === "win32" ? "win" : process.platform) + "-" + process.arch')}
case $plat in linux-x64|linux-arm64|darwin-arm64|darwin-x64|win-x64) ;; *) echo "unsupported platform: $plat" >&2; exit 1 ;; esac

cd "$here"
[ -d node_modules ] || npm ci --no-audit --no-fund --omit=optional
node_modules/.bin/tsc -p tsconfig.json
rm -rf "$ext/backend"
node_modules/.bin/esbuild src/main.ts --bundle --platform=node --format=cjs --target=node22 \
  --external:sherpa-onnx-node --outfile="$ext/backend/index.cjs" --legal-comments=none
mkdir -p "$ext/backend/node_modules"
cp -R node_modules/sherpa-onnx-node "$ext/backend/node_modules/"
ver=$(node -p 'require("./node_modules/sherpa-onnx-node/package.json").version')
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && npm pack --silent "sherpa-onnx-$plat@$ver" >/dev/null && mkdir pkg && tar -xzf ./*.tgz -C pkg --strip-components=1)
mv "$tmp/pkg" "$ext/backend/node_modules/sherpa-onnx-$plat"
echo "$plat" >"$ext/backend/PLATFORM"
du -sh "$ext/backend"
