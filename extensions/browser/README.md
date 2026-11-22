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

Reserved scripts: `typecheck`, `test:backend`, `test:viewer`, `test:pack`, `test:signin`, `build`. Node ≥22.13; Playwright 1.61.1; exact versions in package-lock. Viewer imports browser DTOs directly; both halves import generic snapshot types relatively. Tests use manufactured local HTTP/profile fixtures only. No service restart, installed extension or browser binary is part of this source change. Viewer/package documentation follows in Worker E's sections.

Backend entry for E: `backend/src/index.ts` → `backend/index.cjs`; keep Playwright and ws external and ship their production dependencies beside the bundle, including Playwright's CLI and `playwright-core/browsers.json`. Ready/listen needs no browser install. F integration is a static `createSigninService` import passed as `signin` to `BrowserBackend`; no F-owned stub is present.

Acceptance here uses simulated Halo caller/notice IPC plus real local Chromium. First network download, packaged macOS/Windows installed-channel launch, current-user ACLs and native process cleanup are release gates, not claimed passing tests. Oversized JPEGs exceeding the fixed 512 KiB outbound budget are explicitly reported and dropped; the limiter never queues them. This preserves the protocol budget but does not promise streaming arbitrarily noisy pages.
