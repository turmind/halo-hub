#!/usr/bin/env bash
# Re-create webapp/ — the draw.io static web app bundled by this extension (~60 MB unpacked, ~25 MB zipped).
# Repo-maintenance script: excluded from the release zip (see scripts/pack.mjs); webapp/ itself is gitignored
# and ships only inside the release zip, so run this before `node scripts/pack.mjs extensions/drawio`.
#
#   webapp/ <- the official jgraph/drawio release asset draw.war (a zip of the static webapp), sha256-pinned,
#              with everything an offline iframe editor never loads pruned away:
#                WEB-INF/ META-INF/        Java servlet part of the .war
#                js/diagramly js/grapheditor mxgraph/src   un-minified sources (dev=1 only; app.min.js has them)
#                js/integrate.min.js js/viewer*.min.js      embed.diagrams.net integration scripts
#                connect/                                   Confluence/Jira Connect glue
#                service-worker.js workbox-*.js *.map       PWA; the host page passes pwa=0
#                every *.html but index.html                cloud-storage (Drive/Dropbox/...) callbacks, export3, teams
#                templates/                                 Insert > Template is hidden when offline=1 (5.6 MB, 332 files)
# Bump DRAWIO_VERSION + WAR_SHA256 together, then re-run the harness/real-admin check in README.md.
set -euo pipefail

DRAWIO_VERSION=32.0.2
WAR_SHA256=3cb8abec8e9bfc7504760c9cdc9194ecf7e8de178aa2a1d668801c32ecf1a1a7

cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/draw.war" "https://github.com/jgraph/drawio/releases/download/v${DRAWIO_VERSION}/draw.war"
if command -v sha256sum >/dev/null; then sum=$(sha256sum "$tmp/draw.war" | cut -d' ' -f1); else sum=$(shasum -a 256 "$tmp/draw.war" | cut -d' ' -f1); fi
[ "$sum" = "$WAR_SHA256" ] || { echo "draw.war sha256 mismatch: got $sum, want $WAR_SHA256" >&2; exit 1; }

rm -rf webapp
mkdir webapp
unzip -q "$tmp/draw.war" -d webapp
cd webapp
rm -rf WEB-INF META-INF js/diagramly js/grapheditor mxgraph/src connect templates
rm -f js/integrate.min.js js/viewer.min.js js/viewer-static.min.js service-worker.js workbox-*.js
find . -name '*.map' -delete
find . -maxdepth 1 -name '*.html' ! -name index.html -delete

echo "draw.io ${DRAWIO_VERSION}: $(find . -type f | wc -l) files, $(du -sh . | cut -f1)"
