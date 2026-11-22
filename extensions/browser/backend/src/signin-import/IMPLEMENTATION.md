# Existing sign-in module (Worker F)

Production entry: `createSigninService(host: SigninHost): SigninService` in `index.ts`. Uses D's validated caller, abort signal, context lock, hook-2 confirmation and profile checkpoint. `signinFactory(machine, runner)` is internal fixture injection, not a request/API configuration surface. Public DTOs are imported from the frozen browser protocol, never duplicated.

## Actual support, not hardware claims

| Source / host | Implemented behavior |
|---|---|
| Chromium family / Linux | Read-only SQLite + plaintext or v10 basic CBC; v11 with an already-unlocked, uniquely matching Secret Service item over `unix:path` D-Bus. Missing/locked wallet refuses; no basic fallback for v11. Legacy KWallet-only protocol and abstract/TCP/unixexec bus transports are unavailable. |
| Chromium family / macOS | v10 CBC, PBKDF2 1003; concurrent `/usr/bin/security find-generic-password -w -s <service> -a <account>` calls, one per deduplicated browser item, launched before awaiting any. Hook-2 approval always precedes OS requests. Independent failures, no automatic retry. Prompt serialization/labels belong to macOS. Mocked only. |
| Chromium family / Windows | Legacy current-user DPAPI; v10 AES-256-GCM using DPAPI-wrapped Local State key. OS bridge is stock Windows PowerShell `ProtectedData.Unprotect`, secret input/output on pipes, fixed script/arguments. App-bound key **presence**, v20 or unknown formats refuse before secret API calls. Mocked only. |
| Firefox family / all three | Read-only moz_cookies (schema 10–16), plaintext, persisted unpartitioned/non-container cookies only. Nonempty originAttributes refuses the site's entire source, rather than merging containers or silently unpartitioning. |
| Safari / macOS | Bounded legacy binarycookies header/domain/expiry discovery without logical cookie-name/value access. Listed as unavailable for import because SameSite/partition/host-only fidelity cannot be established. Modern candidate stores likewise unavailable; no invented parser/attribute fallback. |

Discovery descriptors cover Chrome stable/Beta/Dev/Canary; Edge equivalents; Brave stable/Beta/Nightly; Chromium; Vivaldi/snapshot; Opera/Next/Developer/GX; Arc on macOS and Windows MSIX; Firefox/Developer/Nightly plus LibreWolf/Waterfox/Floorp/Zen. Linux standard Snap/Flatpak variants and Firefox MSIX are enumerated. Standard root profiles are enumerated from metadata and actual directories, deduplicated by canonical cookie-store path. Not an arbitrary-browser/home scan: unlisted derivatives/custom/portable roots are not claimed; redirected profile directories are not opened. All matching profiles are returned, not only Default.

## Boundaries and flow

- Explicit hostname scope, IDNA and public/private suffix validation (`tldts`). Explicit subdomain never expands upward; IP/localhost exact-only. Sources performs metadata queries only (tested with name/value/encrypted_value columns absent). A source count is not an authenticated-account claim.
- SQLite is synchronous inside a short-lived worker, not the backend event loop. Read-only transaction sees live WAL, no immutable mode or source checkpoint/write/copy. Exact IP/localhost uses indexed equality; domain suffix discovery must scan the **covering host metadata index**, then uses parameterized exact-host reads. Existing browser schemas have no reversed-domain index, so a suffix seek without that scan is unavailable. No decryption/full-value scan; at most 5,000 scoped rows and 15 s per read. Empty WAL creation is treated as unchanged content. Main/WAL identity/size/mtime fingerprints conservatively refuse any source change during consent/read.
- One chosen source, hook-2 notice discloses site/subdomains/count/profile and workspace sharing. No values/names/OS errors in DTOs/notices/logs. Site reuse can fail or invalidate the original session. Cancellation aborts helpers/workers and local confirmation wait; dispose awaits pending import cleanup. D owns notice revocation/operation TTL/deduplication across service instances.
- Decode every scoped row before mutation; verify schema-24 exact-host SHA256 prefix, session/persistent expiry, SameSite, host-only/domain, Secure/HttpOnly and partition top-level site **plus ancestor bit**. Unknown schemas/envelopes/attributes fail closed. JS strings cannot be reliably zeroized; owned key/value buffers are cleared, never persisted except D's approved target profile/journal.
- Target lock pauses existing page scripts and aborts in-flight/new routed requests during the short cookie write. Active page/service workers are refused because page pause/context routing cannot pause their network. This is not a fully transactional browser; abrupt crash and new/background worker races are not claimed impossible.
- Exact `(name,domain,path,partition site,ancestor)` keys only; no-op writes skipped. On partial failure overwrite old keys and expire newly-created exact keys. Never broad `deleteCookies` without a partition key (it can delete partitioned siblings). Imported session cookies are checkpointed through D, no second journal/temp export.
- `commitCookies` retains undo and context-close tracking through setCookies, script resume, detach/unroute, the outer `withContext` return and checkpoint. Write failures restore before scripts resume; later failures use a fresh CDP session on the same still-open context. Cancellation is reported only before mutation or after confirmed rollback **and undo checkpoint**. Failed undo is not retried; rollback rejection, failed undo checkpoint or target close reports `unavailable` with the allowlisted uncertain reason, never masked by abort. A failed initial checkpoint can be compensated; if undo and its checkpoint succeed it reports restored failure (or cancellation). A successful checkpoint with the context still open commits, including an abort that arrived during that successful checkpoint; no late signal check rewrites imported.
- Within one service, source resolution is shared by normalized `(scope.host, scope.exact)` and imports/approvals by `(scope.host, scope.exact, resolved source.id)`. Equivalent URLs/hostnames and implicit unique source versus its explicit id share one notice/write/checkpoint. Different scopes/sources remain separate; ambiguous implicit sources still require a choice. `siteScope(input): SiteScope` is unchanged. Dispose waits for source resolution as well as commit/cleanup; D still owns deduplication across operation-scoped service instances.

## Host commit contract — D integration still required

The local repair does **not** claim to serialize browser close with the complete transaction. At review base `ff9251d`, `workspace.ts:244–251` checks the request signal before and after each `withContext` callback; F can compensate inside the first callback, but re-entry after an outer abort is rejected. `checkpointNow` at 348–352 silently returns without a context, and `closeBrowser` at 359–371 checkpoints/closes without draining the serial transaction. `backend.ts:241` then checks abort even after F has produced a terminal DTO. These host behaviors contradict an unconditional rollback guarantee; they are outside F's edit boundary.

Required host semantics (no host interface was changed in this patch):

1. Supply an internal, operation-bound cleanup entry on the **original** context, allowed after request abort/lease loss, without reopening a browser or applying normal request-signal checks to undo. Current F calls `host.withContext` for both apply and outer-boundary rollback; until D supplies cleanup semantics, a rejected re-entry intentionally returns uncertain. If D adds a dedicated cleanup callback rather than strengthening this binding, wire `commitCookies`' rollback call to it.
2. Hold an import lifetime guard from first target access until success checkpoint or rollback plus undo checkpoint completes. Close/handoff/background checkpoints must not overlap this interval; serializing individual calls alone is insufficient. Forced teardown may remain bounded, but must propagate failure/uncertainty rather than a successful no-op checkpoint.
3. A checkpoint must durably write the same original context's approved profile/journal or reject. Missing/replaced/closing context must never resolve as success. Undo checkpoint must also be callable after abort.
4. Preserve F's completed import DTO after service disposal: do not apply the blanket final `checkSignal(controller.signal)` to imported/uncertain outcomes. Only F's confirmed-clean cancellation may be called cancelled. Backend operation/completion handling must preserve that distinction as well.

## Production integration

D `backend/src/index.ts` now wires:

```ts
import { createSigninService } from './signin-import/index.js'
// Existing BrowserBackend options, plus:
signin: createSigninService
```

No dependency/lock changes required: locked `tldts`, `@homebridge/dbus-native`, Playwright and Node 22 SQLite suffice. D releases the import-scope deduplication only for cancelled/unavailable outcomes, permitting an explicitly requested retry with a new request ID after normal newer-human resume. Same-ID requests keep their original result; pending/successful imports remain scope-deduplicated. There is no automatic retry or replay of a successful import. F's service remains operation-scoped; D owns this cache.

E packaging: **no compiled bridge/native outputs**. Bundle this module with the backend; the SQLite worker is self-contained `Worker(..., {eval:true})` JavaScript so it survives CJS bundling without a worker file. Leave `node:*` external. Ship the existing `@homebridge/dbus-native` dependency and transitive JS data/assets via the existing production dependency staging; do not attempt to bundle its optional native abstract-socket transport. System `security` / PowerShell are prerequisites, not zip assets. Exclude `*.test.ts`, `fixtures.ts` and this developer document from runtime zips. No source profiles or temporary DB copies ever become build inputs.

## Verification and remaining gates

Commands from worktree root:

```
npm --prefix extensions/browser run typecheck
npm --prefix extensions/browser run test:signin
npm --prefix extensions/browser run test:backend
```

Initial F verification: 33 sign-in tests passed, strict tsc exit 0. Concurrent backend runs exposed `deadlines.test.ts` “No completion notice”: its 100 ms `commandTimeoutMs` override shortened both the response wait and real command execution, so slow navigation/checkpoint closed the workspace and revoked notices. Integration fixes the test with a deferred launch and mocked response timer, restoring real timers before Chromium runs under the unchanged production 30-second execution budget. No production timeout increase or reduced test concurrency is needed. Backend retry coverage adds cancelled/unavailable cases; the extracted-package test now exercises production source discovery and the bundled SQLite worker.

Integration verification: strict tsc exit 0; scoped backend **21/21**, viewer **10/10**, pack **6/6**, sign-in **33/33**. Two combined runs using Node's default test concurrency passed **70/70** each (24.44 s and 23.73 s), with zero failures/skips/cancellations and zero remaining task processes. The pinned Halo snapshot is `91f1b00d9da458cb8be11667715223826423cea3`.

F review repair on `ff9251d`: `npm run typecheck` exit **0**, `npm run test:signin` **53/53** (10.31 s), zero failures/skips/cancellations and zero remaining task processes. Added **20** regressions using the real service/source reader with manufactured SQLite profiles and a stateful target double: detach/unroute abort, callback return/rejection and post-resolution abort before checkpoint, host refusing cleanup, failed undo (including subsequent cleanup failure and rollback detach), initial/undo checkpoint failures, commit-winning late abort, context close at three boundaries, pre-mutation cancellation, canonical-site/source deduplication and distinct-scope/source separation. Existing partial-write test now asserts rollback precedes script resume. The suite still runs the real Chromium HTTP/IPC import/restart test below; real-host cancellation/close coordination remains D's integration gate. Backend/viewer/pack suites were not rerun in this F-only review task; the previous combined-run numbers above remain historical.

Linux end-to-end creates a real manufactured Chromium profile, closes it, makes its cookie DB read-only, imports **4** scoped cookies through real BrowserBackend private HTTP and hook-2 IPC, checks an unrelated source is excluded/an unrelated target retained, closes/restarts backend, proves session-cookie authentication plus both partition ancestor bits restored. Initial F verification repeated this under bwrap read-only root/private tmp. Never uses real profiles/accounts. Process cleanup checked after tests.

Mac/Windows real hardware still required: actual channel/key service pairs, app-data/FDA access, Keychain grant/deny/locked/headless behavior and all-prompts launch, PowerShell policy/DPAPI and live-store sharing locks, MSIX roots, app-bound refusal, packaged launch. Linux real desktop Secret Service compatibility (including KWallet's Secret Service implementation) remains a hardware/session gate. Safari import and Firefox container/partition conversion are explicitly not implemented without faithful-format fixtures.

Halo docs under `.halo/docs/` were held by the task's no-halo-tree boundary. Affected design/API/tool docs and the companion plan need these precise support qualifications propagated by their owning integrator; this module-local note is the in-scope documentation.
