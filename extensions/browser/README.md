# Browser

## Backend and protocol

The browser runs on the Halo server machine, behind the Halo private extension socket, never a public debugging port. It accepts only proxy-validated `X-Halo-Caller` context; production authentication/entitlement, same-origin checks and header stripping belong to Halo hook 1. The protocol is `backend/src/protocol.ts`; generic hook types are a byte-for-byte, SHA-256-pinned development snapshot under `contracts/halo-core/`. Regenerate after coordinated core changes, never edit copies by hand:

```sh
node extensions/browser/scripts/check-core-contract.mjs --source "$HALO_SOURCE_ROOT" --check
```

Routes: `GET /status`, session-only `POST /command`, Admin-only `POST /view` and `GET /stream?viewId=…` WebSocket, bound `GET /operations/:id`, and owner-only `GET /artifacts/:id` for requested PNG screenshots. State, runtime, operation and error messages use the frozen nested envelopes. Viewer subscribes with protocol 1 and acknowledges binary `uint32-be sequence || JPEG` frames **after decode**. Context comes from the host/proxy, not the command body. Screenshots are private, bounded and expire; never expose profile paths or arbitrary files.

One persistent profile per canonical workspace hash, one driver session. Other sessions get `busy`; different workspaces do not share cookies. Multiple viewers are read-only except the single input owner. Handoff fences queued agent work and immediately returns `waiting-for-user`. Resume is an explicit CLI command after a newer authenticated human reply in the same Halo chat. During handoff, no agent DOM, screenshot or mutation access. Typed input is not forwarded to the agent. Import approval is not permission to resume.

At 1280×800 / JPEG 70, delivery is time-capped at 2 FPS for agent/watch and 10 FPS for user input, with one retained latest frame and one outstanding frame per viewer; mode transitions preserve last-send timestamps. No viewers suspends CDP capture. This reduces traffic, **not native Chromium encoding cost** on animated pages.

Data lives in `$HALO_EXT_DATA_DIR/workspaces/<sha256>/`: dedicated `profile/`, atomic session-cookie journal, tabs and ephemeral artifacts. Session partition site and ancestor bit survive restore before navigation; logout writes an empty journal and unchanged state skips writes. Checkpoints coalesce input/navigation/cookie-response events and run after mutations and on close. Quiet script cookie changes can be lost on abrupt crash. Unix directories/files use private modes. Windows creates current-user inheritable ACLs with `whoami`/`icacls`; ACL behavior and process-tree cleanup still need native hardware acceptance.

Desktop target preference is installed stable Chrome, then Edge, then pinned Playwright Chromium; Linux uses pinned Chromium in extension-data. Target profiles never point to ordinary browser profiles. Installer uses Playwright's locking/atomic completion and inherited proxy variables, with a bounded download. Backend ready IPC precedes all downloads and launch. Missing system libraries require administrator action outside the extension, not an automatic privileged install.

Sign-in is supplied by `createSigninService(host)` in `backend/src/signin-import/index.ts`. `signin-service.ts` is the stable D→F port: service `sources`, `import`, `dispose`; host `caller`, `signal`, serialized `withContext`, `checkpoint`, and IPC `confirm`. Consent waits never hold the browser critical-section lock. Until F is integrated, production reports unavailable rather than installing a source-discovery stub.

## Skill CLI

See `skills/browser/SKILL.md`. Commands: `open`, `read`, `click`, `type`, `press`, `scroll`, `screenshot`, `tabs`, `select-tab`, `handoff`, `signin-sources`, `signin-import`, explicit `resume`, redacted `status`, and one-shot `operation`. Uses `HALO_EXT_NODE` and the hook-1 environment map; no keys in arguments, URLs, logs or files. Errors never serialize Playwright/OS/fetch exceptions.

## Development checkpoint

Reserved scripts: `typecheck`, `test:backend`, `test:viewer`, `test:pack`, `test:signin`, `build`. Node ≥22.13; Playwright 1.61.1; exact versions in package-lock. Viewer imports browser DTOs directly; both halves import generic snapshot types relatively. Tests use manufactured local HTTP/profile fixtures only. No service restart, installed extension or browser binary is part of this source change. Viewer/package details are below.

Backend entry for E: `backend/src/index.ts` → `backend/index.cjs`; keep Playwright and ws external and ship their production dependencies beside the bundle, including Playwright's CLI and `playwright-core/browsers.json`. Ready/listen needs no browser install. F integration is a static `createSigninService` import passed as `signin` to `BrowserBackend`; no F-owned stub is present.

Acceptance here uses simulated Halo caller/notice IPC plus real local Chromium. First network download, packaged macOS/Windows installed-channel launch, current-user ACLs and native process cleanup are release gates, not claimed passing tests. Oversized JPEGs exceeding the fixed 512 KiB outbound budget are explicitly reported and dropped; the limiter never queues them. This preserves the protocol budget but does not promise streaming arbitrarily noisy pages.

## Canvas viewer

Requires **Halo 2.4.0** (generic backend hooks and file-less Canvas). Open from Settings → Extensions → Open in Canvas, or the agent's Browser notice. Backend confirmation is still required; installing does not enable the browser skill on every agent. This is a file-less Canvas view, not an activity page or a file preview; no filesystem, save or media grants are requested.

The viewer displays the backend's **2 fps** watch / **10 fps** user-control mode (0 means capture suspended, not a measured frame rate). **Take over** pauses the agent. Only one viewer owns input; others show read-only and cannot select tabs or type. The protocol exposes `canInput`, not the other viewer's identity, so a competing takeover is rejected by the backend with an explanatory banner. Finish by choosing **Back to chat** and telling the agent what to do in that exact chat. There is no Done button, automatic login detection, fabricated chat message or view-side resume command. Back to chat is disabled without host-supplied session context.

Binary JPEGs are decoded before ACK, fit without stretching, and mapped from viewer CSS pixels to the backend's 1280×800 CSS viewport independently of device DPI. Pointer capture handles drags outside the image; blur/cancellation releases held input. Keyboard events carry shortcuts/navigation; textarea composition and plain-text paste use the bounded text frame. File upload/download management, remote clipboard copy/cut, audio/video calls, passkeys and native permission dialogs are explicitly unsupported. Native OS IME, touch keyboards and hardware DPI still require device acceptance; fixture composition is not an OS keyboard test.

Tailwind CSS and JS are bundled locally with no CDN. The viewer applies the host's semantic palette and English/Chinese language frames. It accepts init/theme/lang only from its same-origin parent, and uses the frozen Canvas context for the proxy's header/query (routing metadata, not credentials). Hidden/page-exit closes the stream and clears the image; visibility restoration/remount resolves the view again. Transport loss uses bounded reconnect backoff, never state polling, and never silently retakes input ownership. The backend retains profile/lease state.

## Build and package

From the hub root, with Node ≥22.13, system `zip`/`unzip` and the pinned dependencies installed:

```sh
npm --prefix extensions/browser run typecheck
npm --prefix extensions/browser run test:viewer
npm --prefix extensions/browser run test:pack
npm --prefix extensions/browser run build -- --platform linux-x64
node scripts/pack.mjs extensions/browser --platform linux-x64
# dist/browser-1.0.0-linux-x64.zip + dist/browser-1.0.0.update.json
```

`build.mjs` bundles the viewer to `dist/viewer.{js,css}` and backend to `backend/index.cjs`. Playwright, ws, tldts, D-Bus and their required production dependency closure remain external under `backend/node_modules/`, including the Playwright CLI/browser revision metadata and upstream licenses. Playwright's optional macOS `fsevents` watcher is not used by browser automation. No browser executable or real profile is included. Build uses disposable `.staging/build` and replaces only generated `dist`, `backend/index.cjs`, `backend/node_modules`, `backend/native` — **never `backend/src`**. Concurrent builds in the same worktree are not supported.

The packer explicitly dispatches `browser` to this builder; `voice-input` and `htrans` continue to call `shared/stt-backend/build.sh <dir> <platform>`. Plain pack (no platform flag) zips existing outputs without rebuilding. Browser ZIP contents are allowlisted: manifest, HTML, icon, README, built `dist`, shipped skills, backend bundle, external modules and optional compiled native outputs. Browser source, tests/fixtures, build scripts, contract dev inputs and package lock/config are excluded. The contract license is retained in `dist/halo-core-LICENSE`.

Compatibility follows the hub convention: **`minHalo: "2.4.0"` in generated update JSON**, not the manifest. Since this is unpublished, pack seeds that first value; after release the committed `extensions/browser/update.json` is authoritative and carried forward. Do not commit an unpublished download URL/checksum. A single-platform update lists only that platform and is a verification artifact, not a complete release.

**F handoff:** `build.mjs --platform <platform> --native-dir <compiled-output-directory>` copies only the supplied runtime directory into `backend/native/`. The default lookup is `backend/src/signin-import/native/dist/<platform>/`; each directory must contain runtime outputs only, not sources/fixtures. F must confirm that layout and runtime lookup, and D must stitch `createSigninService` into the entry. Non-linux-x64 builds fail before modifying outputs when that platform directory is missing. `--platforms` release packaging remains gated on all five outputs and native acceptance: linux-x64, linux-arm64, darwin-arm64, darwin-x64, win-x64. This linux-x64 package exercises the existing unavailable-sign-in path until F lands, not completed sign-in import.

Tests use a local fixture host against D's real backend and an independent Chromium viewer (DPR 2), with no live accounts. They cover rendering, mouse/key/composition/paste/wheel/drag/blur, 2→10→2, second-viewer ownership, exact focus-chat, hide/show/reconnect/remount and theme/language. Pack tests inspect ZIP/SHA-256, boot an extracted backend with no development dependencies, validate Canvas rules, and run both STT builders through fixtures on all five platforms. Real Halo Admin host integration, first browser download, native sign-in/IME/process cleanup and Mac/Windows acceptance remain release gates.
