# secretary — Secretary + departments workspace

A "single entry point" workspace: you only talk to the **secretary**. The secretary looks up the **department table** in `.halo/INDEX.md` and uses `relay_send` to dispatch work to the fixed session in the matching department (another workspace on the same server). When the department finishes, its conclusion flows back to the secretary automatically, and the secretary relays it to you. You never have to switch between workspaces yourself.

## What's included

```
.halo/
├── INSTRUCTIONS.md          # General principles + department-table maintenance rules + management modes (Manual / Semi-managed / Fully managed)
├── INDEX.md                 # Department table (3 fictional example rows — edit them)
└── agents/
    ├── default/             # Secretary: overrides the built-in default, carries only relay_* + file/shell tools; dispatches work, receives reports, follows up, interrupts, stops
    ├── ws-builder/          # Sub-agent: builds a workspace for a new department from scratch and hands the "new department-table row" back to the secretary
    └── backup/              # Sub-agent (optional): syncs department workspaces to S3, verifies consistency, retires local directories
```

## Requirements

- **Halo ≥ 1.5.5, server mode**. The `relay_*` tools only work inside the server (calls from CLI / TUI fail), and are only enabled for **full access** sessions.
- The department workspaces **already exist on the same server** (with a `.halo/` directory); for any that don't, the secretary can hand it to `ws-builder` to build.
- Model: `agents/*/agent.yaml` uses `aws-bedrock-claude-invoke` + Claude Sonnet / Opus 5.5. To switch to another provider, change the `model:` block in each `agent.yaml` (`provider` / `id` / `endpoint` are all required).
- The `backup` agent needs the `aws` CLI installed locally, with credentials that can write to your bucket; if you don't need backups, delete it as described in "No backup feature" below.

## Installation (manual for now)

1. Put this `.halo/` in the root of the target project (any empty directory will do):
   ```sh
   cp -r workspaces/secretary/.halo /path/to/your-secretary-project/
   ```
2. Have the Halo server open this directory (add / switch workspace in admin).
3. Later, `/workspace import` will go live and replace this manual copy step.

## Edit these first

| Location | Placeholder / example | How to change |
|------|------|------|
| `.halo/INDEX.md` department table | Three fictional example rows: `research` / `ops` / `archive` | Replace with your own departments: `workspace` = a real absolute path, `agent` = an agent id that actually exists in that workspace (leave blank if unsure), `session` in `secretary-<department>` style, `Status` = Enabled / Disabled, `Management mode` = Manual / Semi-managed / Fully managed |
| `.halo/INSTRUCTIONS.md` section 2 | `/path/to/workspaces` | The parent directory where you keep the department workspaces; new departments are created under it by default |
| `.halo/INSTRUCTIONS.md` section 2, "Backup / retire to S3" in `agents/default/AGENT.md`, `agents/backup/AGENT.md` | `<your-bucket>`, `<backup-prefix>` | Your S3 bucket name and backup prefix (keep all three places consistent) |
| "Input" section of `agents/ws-builder/AGENT.md` | `/path/to/workspaces/<short-name>` | Same as the department workspace root directory above |
| `model:` in each `agent.yaml` | Bedrock / us-east-1 public endpoint | Adjust to the provider you can actually use |

### No backup feature

Delete `.halo/agents/backup/`; remove `backup` from `team:` in `agents/default/agent.yaml`; delete the "Backup / retire to S3" section of `agents/default/AGENT.md`; in section 2 of `INSTRUCTIONS.md`, delete or edit the "Department retirement" and "Department workspace backup" items as needed.

## How it works (quick reference)

- **Dispatch**: `relay_send(workspace, session_id, agent_id, message)`. One fixed session per department, created automatically if it doesn't exist; when busy, messages are queued.
- **Receiving reports**: when a department finishes, `[Relay report · …]` lands in the secretary session automatically; if truncated, use `relay_read` for the full text; `[RELAY TARGET ABORTED …]` means the department hit an error and aborted.
- **Follow-up / interrupt / stop / check progress**: `relay_send` (follow-up), `relay_interrupt` (hard interrupt), `relay_stop`, `relay_read` / `relay_list`.
- **New department**: build it with `start_session(agent_id="ws-builder", …)`; after getting the "new department-table row" back, the secretary writes it into `INDEX.md`.
- **File delivery**: the department leaves files in its own directory and gives the absolute path in its report; the secretary then forwards them with `MEDIA:<path>` (`send-file` skill).
- **Unknown requests**: if the table has no matching department, ask the user; don't guess paths and don't do the department's work.

## Not included

Built-in agents / skills (`executor`, `send-file`, `cron`, etc.) ship with the recipient's server and are not in this bundle; `USER.md`, `memory/`, sessions and logs are likewise excluded — they accumulate anew in your own environment.
