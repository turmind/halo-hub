---
name: browser
description: Browse together in Canvas; read while the user operates, continue actions after their next chat message.
---

# Browser

A shared workspace browser on the Halo server; users can interact and navigate directly in Canvas.

- POSIX: `"$HALO_EXT_NODE" "<this skill directory>/browser.mjs" <command>`
- Windows cmd: `"%HALO_EXT_NODE%" "<this skill directory>\browser.mjs" <command>`

## Commands

- `open <http(s)-url>` — navigate the selected tab and offer Canvas.
- `read` — page text, ARIA snapshot and `snapshotId:ref` targets.
- `click <snapshotId:ref>` / `type <snapshotId:ref> <text>` — interact using current targets; re-read stale refs.
- `press <key>` / `scroll <dx> <dy>` — keyboard or scrolling.
- `screenshot <scratch-file.png>` — save a requested screenshot without overwriting.
- `tabs` / `select-tab <id>` — list or select tabs.
- `close-tab <id>` — close a tab; the last becomes blank.
- `handoff [reason]` — ask the user to act in Canvas.
- `signin-sources <site>` — list existing server-side sign-in sources.
- `signin-import <site> [--from <source-id>]` — request consent to copy one source; copying does not prove login.
- `status` — runtime status.
- `operation <id>` — retrieve a pushed completion once; retain the ID from pending output, never poll or replay the mutation.

## Rules

1. While the user operates, `read`, `tabs`, `screenshot` and `status` remain available; actions wait. Any new user message in this chat is permission: continue directly, without asking again. The backend automatically returns control on your next action.
2. On `waiting-for-user`, say “Reply in this chat when finished,” then end this turn; never poll. Import consent alone is not permission to continue.
3. Never enter account credentials for users; use `handoff` for login. Never expose backend keys or profile files.
4. On `busy`, tell the user another session is using the browser.
5. Do not repeat successful imports; equivalent requests deduplicate. Retry failed/cancelled imports only when requested; uncertain outcomes require user inspection, not a claim of success.

## Sign-in import on macOS

1. Run `signin-sources <site>`; relay the `privacy` reason's Full Disk Access instructions to the user.
2. Before retrying import, ask permission to close tabs listed in `activeWorkers`; obtain fresh IDs with `tabs`, never reuse pre-restart IDs.
3. For Keychain “Chrome Safe Storage”, ask the user to click Allow.
4. After completion, fetch `operation <id>` once; `open` a signed-in page and `read` to verify. Imported cookies alone prove nothing.

Windows: `locked` can mean the running browser occupies files; ask the user to fully quit it, warning that session cookies may be lost.
