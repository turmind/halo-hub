#!/usr/bin/env bash
# Re-fetch the third-party runtime files bundled in this extension (into vendor/).
# Repo-maintenance script: excluded from the release zip (see scripts/pack.mjs).
# Run after bumping a version below, then commit the changed files.
#
#   vendor/marked.min.js        <- marked/marked.min.js              (UMD, copied verbatim)
#   vendor/purify.min.js        <- dompurify/dist/purify.min.js      (UMD, copied verbatim)
#   vendor/highlight.min.js     <- @highlightjs/cdn-assets/highlight.min.js   ("common" bundle: python, js/ts, sql, bash, r, json, ...)
#   vendor/hljs-julia.min.js    <- @highlightjs/cdn-assets/languages/julia.min.js  (not in the common bundle)
#   vendor/katex/katex.min.js   <- katex/dist/katex.min.js           (copied verbatim)
#   vendor/katex/katex.min.css  <- katex/dist/katex.min.css with the .woff/.ttf fallbacks removed
#   vendor/katex/fonts/*.woff2  <- katex/dist/fonts/*.woff2          (woff2 only: every browser halo supports reads it; -0.6 MB)
#   vendor/codemirror.js        <- src/codemirror.js bundled by esbuild (ESM, minified): CodeMirror 6 + python, markdown,
#                                  javascript / typescript, sql, r, julia, shell modes; app.js imports it on first edit
set -euo pipefail

MARKED_VERSION=15.0.12
DOMPURIFY_VERSION=3.4.16
HIGHLIGHTJS_VERSION=11.12.0
KATEX_VERSION=0.19.0
ESBUILD_VERSION=0.28.2
# CodeMirror 6 packages (exact pins; transitive deps resolve from these)
CM_PACKAGES="@codemirror/state@6.7.6 @codemirror/view@6.43.14 @codemirror/commands@6.11.1 @codemirror/language@6.13.1
  @codemirror/autocomplete@6.20.3 @codemirror/lang-python@6.2.1 @codemirror/lang-markdown@6.5.2
  @codemirror/lang-javascript@6.2.5 @codemirror/lang-sql@6.10.0 @codemirror/legacy-modes@6.5.5 @lezer/highlight@1.2.5"

cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

(cd "$tmp" && npm init -y >/dev/null \
  && npm i --no-audit --no-fund --ignore-scripts \
       "marked@${MARKED_VERSION}" "dompurify@${DOMPURIFY_VERSION}" \
       "@highlightjs/cdn-assets@${HIGHLIGHTJS_VERSION}" "katex@${KATEX_VERSION}" \
       "esbuild@${ESBUILD_VERSION}" ${CM_PACKAGES})

nm="$tmp/node_modules"
rm -rf vendor
mkdir -p vendor/katex/fonts

cp "$nm/marked/marked.min.js" vendor/marked.min.js
cp "$nm/dompurify/dist/purify.min.js" vendor/purify.min.js
cp "$nm/@highlightjs/cdn-assets/highlight.min.js" vendor/highlight.min.js
cp "$nm/@highlightjs/cdn-assets/languages/julia.min.js" vendor/hljs-julia.min.js
cp "$nm/katex/dist/katex.min.js" vendor/katex/katex.min.js
cp "$nm"/katex/dist/fonts/*.woff2 vendor/katex/fonts/
# Each @font-face lists woff2, woff, ttf in that order; keep only the woff2 source.
sed -E 's/,url\(fonts\/[^)]*\.woff\) format\("woff"\),url\(fonts\/[^)]*\.ttf\) format\("truetype"\)//g' \
  "$nm/katex/dist/katex.min.css" > vendor/katex/katex.min.css
if grep -Eq '\.(woff|ttf)\b' vendor/katex/katex.min.css; then echo "katex.min.css still references woff/ttf" >&2; exit 1; fi
cp src/codemirror.js "$tmp/codemirror.js"
"$nm/.bin/esbuild" "$tmp/codemirror.js" --bundle --format=esm --minify --target=es2020 --legal-comments=none \
  --outfile=vendor/codemirror.js

echo "marked ${MARKED_VERSION}, dompurify ${DOMPURIFY_VERSION}, highlight.js ${HIGHLIGHTJS_VERSION}, katex ${KATEX_VERSION}, codemirror bundle $(wc -c < vendor/codemirror.js) B"
