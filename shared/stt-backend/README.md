# stt-backend — on-device speech-to-text for extension backends

SenseVoice-Small + Silero VAD (+ pyannote / CAM++ speaker labels) via sherpa-onnx, as a Halo extension **backend**: a Node
program Halo (≥ 2.3.0) runs on demand as the extension's own child process behind `/api/ext/<id>/*` and stops after 5
idle minutes — so the ~400 MB the engine pins is given back when nobody dictates. Ported from Halo's former built-in STT
(halo-agent `packages/server/src/stt/` + `routes/stt-ws.ts`), behaviour unchanged: same models, languages, decode
queue caps, speaker labelling and WS frames.

Built **into** each extension that uses it (`voice-input`, `htrans`) — one copy per extension, no shared install, no
extension depending on another:

```bash
shared/stt-backend/build.sh extensions/voice-input [<os>-<arch>]   # → extensions/voice-input/backend/
node scripts/pack.mjs extensions/voice-input --platforms           # all five platforms, zips + update.json
```

`backend/` holds `index.cjs` (esbuild bundle, `ws` inlined), `node_modules/sherpa-onnx-node` and the native
`sherpa-onnx-<os>-<arch>` package for one platform (fetched with `npm pack`, no compiler).

| | |
|---|---|
| WS `/stream[?speakers=1]` | PCM s16le mono 16 kHz in; `model` / `ready` / `final` / `error` frames out (Halo's old `/api/stt/stream` protocol) |
| Models | `$HALO_EXT_DATA_DIR/models/` (`~/.halo/global/extension-data/<id>/models/`, kept across updates), ~271 MB, fetched from Hugging Face with a ModelScope fallback, resumed from `.part`, sha256-verified. The download starts when Halo first starts the backend (right after the admin confirms it) and on every stream while incomplete; while it runs with no stream open the backend tells Halo `busy` so the idle stop waits |
| Writes | only `$HALO_EXT_DATA_DIR/models/` (`<name>.part`, then a rename). No audio, no text, no logs of recognized text. Under Halo's Linux write isolation (bwrap) that dir and a private /tmp are the only writable paths, which is all it needs |
| Each extension | its own data dir, so voice-input and htrans each download the model set once (~271 MB each on disk) |

Tests (no network, no native addon, no model files — engine and downloader are stubbed or pointed at a local server):

```bash
cd shared/stt-backend && npm ci && npm test && npm run typecheck
```

`test/stream.test.ts` covers the `/stream` frames, `engine` / `models` / `speakers` the ported units, and `main.test.ts`
the process contract with Halo (IPC `ready` / `busy`, 1001 on SIGTERM). The admin-cookie check and the extension lookup
are Halo's proxy's, tested in halo-agent `packages/server/test/extension-backend.test.ts`.
