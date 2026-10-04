# Secretary workspace · department index

The secretary dispatches work from this table only. `workspace` is the `workspace` parameter of `relay_send`, and `session` is the `session_id` parameter (fixed naming; if it doesn't exist, `relay_send` creates it automatically using the agent in the `agent` column; if `agent` is empty, that workspace's default agent is used).

For maintenance rules see section 2 of `.halo/INSTRUCTIONS.md`.

> 📝 **The three rows below are fictional examples — replace them with your own departments first.** `workspace` must be a real absolute path on the same server that contains `.halo/`, otherwise `relay_send` will report not a halo workspace.

| Department | Responsibilities | workspace | agent | session | Status | Notes | Management mode |
|------|------|-----------|-------|---------|------|------|------|
| research | Information research / competitor analysis / literature compilation | `/path/to/workspaces/research` | `default` | `secretary-research` | Enabled | Example row: research-type work belongs here | Manual |
| ops | Production operations / routine inspection / incident troubleshooting | `/path/to/workspaces/ops` | `oncall` | `secretary-ops` | Enabled | Example row: `oncall` is an agent defined by that workspace itself; fill it in only after confirming with `ls <workspace>/.halo/agents` | Semi-managed |
| archive | Archiving of past projects | `/path/to/workspaces/archive` | | `secretary-archive` | **Disabled** | Example row: departments with Disabled status get no work; `agent` left empty = use that workspace's default agent | Manual |

## Communication records with departments

Requirements, progress and pending items sent to each department are kept, per department, in a `<department>/` folder at the workspace root; how it is organized is up to the secretary, and it is updated continuously. Example (optional; create only for departments that need long-term requirement tracking):
- research: `research/requests.md` (one file with three sections: In progress / To do / Done; when a status changes, move that line to the matching section)
