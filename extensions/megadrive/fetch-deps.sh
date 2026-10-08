#!/usr/bin/env bash
# Re-create emulatorjs/ — the EmulatorJS runtime + Genesis Plus GX core bundled by this extension (~2 MB).
# Repo-maintenance script: excluded from the release zip (see scripts/pack.mjs); emulatorjs/ itself is gitignored
# and ships only inside the release zip, so run this before `node scripts/pack.mjs extensions/megadrive`.
#
#   emulatorjs/ <- npm @emulatorjs/emulatorjs (GPL-3.0, unminified sources = the source code) and
#                  npm @emulatorjs/core-genesis_plus_gx (prebuilt RetroArch + Genesis Plus GX wasm), both sha256-pinned.
#                  Only what an offline single-player Genesis page loads is copied:
#                    src/{emulator,storage,gamepad,GameManager,compression}.js, emulator.css
#                    src/shaders.js                          the GLSL display filters (Display menu)
#                    compression/{extractzip,extract7z}.js   unpack a .zip / .7z ROM, un-7z the core
#                    localization/zh-CN.json                 Chinese UI (English is built in)
#                    cores/genesis_plus_gx-legacy-wasm.data  the variant EmulatorJS 4.2.3 picks: the core report has no
#                                                            defaultWebGL2, so it loads "-legacy" (WebGL 1) on every
#                                                            browser; "-thread" variants need COOP/COEP, which Halo doesn't send
#                    cores/reports/genesis_plus_gx.json      build stamp EmulatorJS reads before the core
#                    LICENSE                                 GPL-3.0 text from the EmulatorJS package
#                  Not copied: loader.js (app.js boots EmulatorJS itself), socket.io (netplay), libunrar,
#                  nipplejs (only the virtual-gamepad "zone" type uses it; our layout has none).
#                  Then emulatorjs-offline.patch is applied to src/emulator.js (see NOTICE): no update check, no CDN core fallback.
# Bump the versions + sha256 together, then re-run the dev check in README.md.
set -euo pipefail

EJS_VERSION=4.2.3
EJS_SHA256=8033a18a3398cae5efd7a4c12a633b10672435977290959633d671365b589639
GPGX_VERSION=4.2.3
GPGX_SHA256=3f4ac27829f3a86734cb1b27f62078a1f1413f08cb0bb7e421b95aec31a0dfa3

cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
fetch() { # name version sha256 → $tmp/<name>/package
  curl -fsSL -o "$tmp/$1.tgz" "https://registry.npmjs.org/@emulatorjs/$1/-/$1-$2.tgz"
  local got; got=$(sha "$tmp/$1.tgz")
  [ "$got" = "$3" ] || { echo "$1-$2.tgz sha256 mismatch: got $got, want $3" >&2; exit 1; }
  mkdir -p "$tmp/$1" && tar xzf "$tmp/$1.tgz" -C "$tmp/$1"
}
fetch emulatorjs "$EJS_VERSION" "$EJS_SHA256"
fetch core-genesis_plus_gx "$GPGX_VERSION" "$GPGX_SHA256"

e="$tmp/emulatorjs/package"
rm -rf emulatorjs
mkdir -p emulatorjs/src emulatorjs/compression emulatorjs/localization emulatorjs/cores/reports
cp "$e/LICENSE" emulatorjs/LICENSE
cp "$e/data/emulator.css" emulatorjs/
for f in emulator storage gamepad GameManager compression shaders; do cp "$e/data/src/$f.js" emulatorjs/src/; done
cp "$e/data/compression/extractzip.js" "$e/data/compression/extract7z.js" emulatorjs/compression/
cp "$e/data/localization/zh-CN.json" emulatorjs/localization/
c="$tmp/core-genesis_plus_gx/package"
cp "$c/genesis_plus_gx-legacy-wasm.data" emulatorjs/cores/
cp "$c/reports/genesis_plus_gx.json" emulatorjs/cores/reports/
patch -s -p1 -d emulatorjs < emulatorjs-offline.patch

echo "EmulatorJS ${EJS_VERSION} + genesis_plus_gx ${GPGX_VERSION}: $(find emulatorjs -type f | wc -l) files, $(du -sh emulatorjs | cut -f1)"
