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
- Exact `(name,domain,path,partition site,ancestor)` keys only; no-op writes skipped. On partial failure overwrite old keys and expire newly-created exact keys. Never broad `deleteCookies` without a partition key (it can delete partitioned siblings). Rollback/checkpoint failure reports state uncertain. Imported session cookies are checkpointed through D, no second journal/temp export.

## Integration requests (outside F scope)

D `backend/src/index.ts` needs:

```ts
import { createSigninService } from './signin-import/index.js'
// Existing BrowserBackend options, plus:
signin: createSigninService
```

No dependency/lock/script changes requested: locked `tldts`, `@homebridge/dbus-native`, Playwright and Node 22 SQLite suffice. D currently caches same `signin-import` args until operation expiry even for cancelled/unavailable outcomes; an explicit retry with identical args needs D to permit a new operation after those terminal outcomes (not auto-retry, and not replay a successful import). F's service is deliberately operation-scoped and cannot change that cache.

E packaging: **no compiled bridge/native outputs**. Bundle this module with the backend; the SQLite worker is self-contained `Worker(..., {eval:true})` JavaScript so it survives CJS bundling without a worker file. Leave `node:*` external. Ship the existing `@homebridge/dbus-native` dependency and transitive JS data/assets via the existing production dependency staging; do not attempt to bundle its optional native abstract-socket transport. System `security` / PowerShell are prerequisites, not zip assets. Exclude `*.test.ts`, `fixtures.ts` and this developer document from runtime zips. No source profiles or temporary DB copies ever become build inputs.

## Verification and remaining gates

Commands from worktree root:

```
npm --prefix extensions/browser run typecheck
npm --prefix extensions/browser run test:signin
npm --prefix extensions/browser run test:backend
```

33 sign-in tests pass (0 failures), strict tsc exit 0. D's 19 existing backend tests passed initially; subsequent concurrent runs produced 18/19 with `deadlines.test.ts` “No completion notice” (100 ms command deadline under competing Chromium launches). That file alone passed 4/4; all 19 passed with `node --import tsx --test --test-concurrency=1 test/backend/*.test.ts`. This test never imports F, and D's files were not changed. Keep the concurrency-sensitive regression visible rather than calling every run green. Linux end-to-end creates a real manufactured Chromium profile, closes it, makes its cookie DB read-only, imports **4** scoped cookies through real BrowserBackend private HTTP and hook-2 IPC, checks an unrelated source is excluded/an unrelated target retained, closes/restarts backend, proves session-cookie authentication plus both partition ancestor bits restored. Repeated under bwrap read-only root/private tmp. Never uses real profiles/accounts. Process cleanup checked after tests.

Mac/Windows real hardware still required: actual channel/key service pairs, app-data/FDA access, Keychain grant/deny/locked/headless behavior and all-prompts launch, PowerShell policy/DPAPI and live-store sharing locks, MSIX roots, app-bound refusal, packaged launch. Linux real desktop Secret Service compatibility (including KWallet's Secret Service implementation) remains a hardware/session gate. Safari import and Firefox container/partition conversion are explicitly not implemented without faithful-format fixtures.

Halo docs under `.halo/docs/` were held by the task's no-halo-tree boundary. Affected design/API/tool docs and the companion plan need these precise support qualifications propagated by their owning integrator; this module-local note is the in-scope documentation.
