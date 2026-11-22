---
name: browser
description: Browse a shared workspace browser, watch it in Canvas, and hand control to the user for sign-in.
---

# Browser

Runs on the **Halo server machine**, not the remote Admin computer. One persistent profile per workspace is shared with later enabled full-access sessions. One session drives at a time: `busy` means wait or ask the user, never take over another session.

Launch the sibling `browser.mjs` with the bundled runtime (quote both paths):

- POSIX: `"$HALO_EXT_NODE" "<this skill directory>/browser.mjs" <command>`
- Windows cmd: `"%HALO_EXT_NODE%" "<this skill directory>\browser.mjs" <command>`

Requires the enabled extension skill and confirmed backend in a full-access Halo server session. Do **not** print `HALO_EXT_BACKENDS`, read profile files, or put credentials in command arguments. No standalone CLI/TUI/AgentCore access.

## Commands

- `open <http(s)-url>` — navigate the selected tab, open/reveal notice for Canvas.
- `read` — bounded visible text + ARIA snapshot + `snapshotId` and refs.
- `click <snapshotId:ref>` / `type <snapshotId:ref> <text>` — live snapshot only. Re-read when stale; no CSS/JS/CDP fallback. Never type account secrets on the user's behalf.
- `press <key>` / `scroll <dx> <dy>` — normal page actions.
- `screenshot <workspace-scratch-file.png>` — explicitly requested PNG only, saved without overwriting an existing file. Use a path in the workspace's scratch area, then the image tool to inspect it.
- `tabs` / `select-tab <id>` — tabs share the workspace profile.
- `handoff [reason]` — returns `waiting-for-user`. Tell the user to take control in Browser Canvas, then **end this turn**. No waiting shell or polling loop.
- `signin-sources <site>` — metadata only from the server machine; no cookie names/values. Available is not proof of authentication.
- `signin-import <site> [--from <source-id>]` — user-consented copy from one source, never merged accounts. `imported` is not proof of sign-in. If unavailable, offer sign-in in Canvas. After `cancelled` or `unavailable`, retry only if the user explicitly requests it; first resume after their new chat reply. Never automatically retry or repeat an imported result.
- `resume` — internal `control.resume`, **only after you interpret a new human reply in this exact Halo chat** as permission to continue. The backend requires a newer human-input marker and no pending import approval. It cannot infer what “done” means. Do not auto-resume on a notice result.
- `status` — redacted runtime state; allowed while user controls the browser.
- `operation <id>` — one-shot retrieval after a pushed completion/new chat turn. Never poll. `running` returns the operation ID; don't repeat the original mutation under a new ID.

While user owns control, **all agent reads, screenshots and mutations are denied**. A same-turn or different-session `resume` cannot reclaim control. Canvas has Back to chat; completion must be a real user message, not a viewer Done button. Import consent authorizes copying, not resumption. After resuming, read the page; never claim login success from a URL heuristic.

2 FPS while watching/agent driving, 10 FPS while user controls input, then 2 FPS on resume. Multiple viewers may watch; only one owns input. No visible viewer suspends capture. Hidden tabs do not hold the browser forever; an idle lease closes after five minutes, or thirty minutes for unattended handoff.

Native file dialogs, upload/download management, clipboard chrome, passkeys and audio/video conferencing are not supported. Sign-ins persist in the dedicated profile; session-cookie checkpoints are event-driven and crash-bounded, not zero-loss. No real user profile is launched or modified.
