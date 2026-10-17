---
name: agentcore-deploy
description: Deploy a Halo workspace to Amazon Bedrock AgentCore Runtime (`halo agentcore` in an arm64 container, workspace on EFS). Base deploy picks the protocol — a2a (an A2A remote other Halo servers call over sigv4) or http (POST /invocations, optional IM push of each result). Optional schedule add-on (http only) moves a local cron job to EventBridge Scheduler. Activate when the user wants a workspace / agent / cron job to run on AgentCore, or asks about an existing AgentCore deploy (status, logs, test, update, tear down).
requiresAccess: full
---
# agentcore-deploy

Turns one workspace into one AgentCore runtime. Everything goes through two
scripts next to this file (use `<workspace>/.halo/skills/agentcore-deploy/` if it
exists, else `~/.halo/global/skills/agentcore-deploy/`):

- `scan.py <workspace> …` — read-only dependency report.
- `deploy.py <phase> -c <job>.yaml [--dry-run]` — does the deploy, one phase at a time.

Requirements on the machine running it: Python 3 + boto3, AWS credentials for the
target account, docker buildx with an arm64 builder; for `sync` / `gc`, docker
that may run `--privileged --network host` (efs-utils runs in a throwaway
amazonlinux container — nothing to install on the host), a network path to the
mount targets' 2049, and an identity allowed `elasticfilesystem:ClientMount` /
`ClientWrite` / `ClientRootAccess` on the deploy's EFS. The image needs
Halo ≥ 2.0.2 (`halo agentcore` with `/invocations`).

## Rules

- **Dry-run first, every phase.** Show the user the dry-run output (requests,
  policies, file list) and get a yes before the real run. Never run `destroy`,
  `gc --apply`, `sync --force` or `schedule --enable` without an explicit yes
  for that exact command.
- **Never print secrets.** Channel credentials live in a 0600 env file named by
  `notify.env_file`; collector tokens in a 0600 file named by
  `observability.headers_file`. Never paste their values into the config, the
  chat, or a file in the workspace. deploy.py masks them in its output.
- **Ask about data before the first sync** (see "Data" below) — never pick for
  the user.
- The job config lives outside the workspace being deployed (it names secret
  files; the workspace may be someone else's). Suggest `~/agentcore-jobs/<name>.yaml`.
- One runtime per config. Same workspace callable both ways → two configs, two
  runtimes (same image), not one hybrid.

## 1. Base deploy

### Choose the protocol

| `protocol` | AgentCore serverProtocol | Port | Callers | Result goes to |
|---|---|---|---|---|
| `a2a` | A2A | 9000 | Halo servers (or any A2A client) with an `auth: sigv4` remote | the caller (A2A task) |
| `http` | HTTP | 8080 | anything that can sign `InvokeAgentRuntime` — scripts, EventBridge Scheduler | the HTTP response, plus IM push if `notify` is set |

Same image and same command (`halo agentcore`) either way; the protocol only
picks serverProtocol + port. The process serves all routes; AgentCore forwards
only its protocol's paths. An `a2a` runtime needs `.halo/agent-card.json`
(`deploy.py card` prints a draft — save it where the user approves, or point
`agent_card:` at a file outside the workspace).

### Config

```yaml
name: coach-http                 # lowercase, 2–31 chars: names runtime, roles, access point
workspace: /home/me/english-agent
protocol: http                   # a2a | http
region: ap-northeast-1
data: none                       # none | all | [paths, session:<id>] — ask the user
network:
  vpc: vpc-…
  subnets: [subnet-…, subnet-…]  # private subnets with a route to Bedrock / the IM APIs; one EFS mount target per AZ
  # sync_sg: sg-…                # the sync host's SG for the EFS SG to admit (default: this EC2 host's only SG)
notify:                          # http only, optional
  env_file: ~/agentcore-jobs/coach.env
observability:                   # optional OTLP export
  endpoint: http://collector:4318
  service_name: coach-http
  headers: "authorization=Bearer ${OTEL_TOKEN}"   # ${VAR} read from headers_file
  headers_file: ~/agentcore-jobs/otel.env
apt: [file]                      # extra Debian packages the scan asked for
iam:
  allow_actions: []              # extra actions the scan found that the user wants granted
  ignore_actions: []             # found but deliberately not granted
agent_card: ~/agentcore-jobs/coach.agent-card.json   # a2a only, optional
halo_version: 2.0.2              # or halo_tgz: <path to a packed tgz>
builder: arm64builder            # docker buildx builder
```

### Phases

Run in this order, each with `--dry-run` first:

1. `scan` — read the report with the user. **Blockers** must be fixed or
   accepted (a skill the job never uses can stay broken). `apt:` and
   `iam.allow_actions` / `iam.ignore_actions` resolve the image / IAM ones.
2. `card` (a2a only) — draft card; the user reviews wording and examples.
3. `infra` — the deploy's own encrypted EFS, mount targets, EFS SG (2049 from
   the runtime SG + sync host only), runtime SG, access point (root dir
   `/halo-agentcore/<name>`), execution role, then the FS policy (deny non-TLS,
   deny without an access point, allow this role through its own access point).
   The role grants only what the scan found; every policy goes through IAM
   Access Analyzer first. Old configs with `network.efs` / `efs_sg` are refused.
4. `image` — builds and pushes the arm64 image (node:22-slim + Halo;
   `tini` is PID 1 so orphans of the agent's shell get reaped, `halo agentcore`
   runs under it).
5. `runtime` — creates / updates the runtime (VPC mode, EFS at `/mnt/efs`).
6. `sync --template` — copies the copy set to `<ap>/.template`; every new
   runtime session id starts from a copy of it.
7. `test` — one call. http: sync `/invocations` (`--async` for the receipt +
   wait for the notify log line); a2a: SendMessage blocking.

Later: `status` (ids + recent log lines), `gc` (session dirs idle for
`--older-than` days, plus the front's `.tmp-*` half-done copies older than
1 h; `--apply` deletes), `destroy` (schedule, runtime, roles,
runtime SG; `--purge-data` also the access point, mount targets, EFS with all
its data, EFS SG). SG deletes wait up to 15 min for AgentCore's ENIs, then say
so and leave the SG for a later `destroy`. Never the ECR repo.

Isolation to tell the user: runtimes can't read each other (own EFS + policy +
role). Inside one runtime, sessions are protected from accidental reads only —
a deliberate agent can reach the shared access point via the microVM's NFS
proxy or the role credentials. Callers that must not see each other get
separate runtimes.

### Data

Before the first `sync`, run `scan` and show the user the **DATA** block (top-level
entries with sizes), then ask which to carry:

- `none` (default) — agent config only (`.halo/agents`, `skills`, `prompts`,
  INSTRUCTIONS / INDEX / USER.md, agent card) plus files the job prompt names.
- `all` — the whole workspace.
- a list — config plus those paths; `session:<id>` carries one session's history
  (schedule add-on only, see below).

Always left out whatever they pick: `.halo/{sessions,tmp,logs,secrets}`,
`*.db*`, lock / lease files, `node_modules`, `__pycache__`, `.ssh` / `.aws` /
`.gnupg`, `.halo/settings.yaml`, secret-looking files (`.env*`, keys, `credentials`…).

Tell them the cost: each new caller (runtime session id) gets a full copy, so
EFS holds size × callers, and the first call of a new id waits for the copy.
`sync --dry-run` prints every file and the total.

## 2. Schedule add-on (protocol http only)

Moves a local cron job to EventBridge Scheduler calling `InvokeAgentRuntime`
directly. A2A runtimes can't be scheduled: Scheduler can't send the
`A2A-Version` header.

```yaml
schedule:
  cron_job: cron-…               # the local job (prompt, agent, session, schedule)
  # session_id: job-<name>-000…  # runtime session id = the job's EFS dir (≥ 33 chars)
  # expression / timezone        # override the converted cron
notify:
  env_file: ~/agentcore-jobs/coach.env
```

- `scan` (with `schedule:` set) maps the job's chat targets to notify env vars.
  WeChat can't push from AgentCore; Feishu / Slack / Telegram / WeCom can. A
  WeCom 智能机器人 keeps one live connection per bot — use one no Halo server
  is connected to.
- `sync` (no `--template`) writes the job's own dir, with the prompt as
  `.halo/jobs/<name>.md` (host paths rewritten to `/workspace`).
  `data: [session:<id>]` carries the job's chat session so it resumes there.
- `schedule --test-in N` — one one-shot `at()` N minutes from now, deleted after
  it fires. Do this first and check the push arrived.
- `schedule` — the recurring schedule, created **DISABLED**; `--enable` only on
  the user's yes. Disable the local cron job yourself once it runs on AgentCore,
  or both fire.

Each fire sends `{"promptFile", "session", "id": "<schedule-arn>@<scheduled-time>",
"async": true}`; a retried attempt with the same id runs once.

## Notify env (http)

notify.py runs when each `/invocations` run finishes and pushes the final reply
(and `MEDIA:` attachments) to every channel whose variables are set:

| Channel | Variables |
|---|---|
| Feishu / Lark | `FEISHU_APP_ID` `FEISHU_APP_SECRET` `FEISHU_RECEIVE_ID` (+ `FEISHU_RECEIVE_ID_TYPE`, `FEISHU_API_BASE`) |
| Slack | `SLACK_BOT_TOKEN` `SLACK_CHANNEL` |
| Telegram | `TELEGRAM_BOT_TOKEN` `TELEGRAM_CHAT_ID` |
| WeCom group webhook | `WECOM_WEBHOOK_KEY` |
| WeCom 智能机器人 | `WECOM_BOT_ID` `WECOM_BOT_SECRET` `WECOM_CHAT_ID` (+ `WECOM_CHAT_TYPE`) |

The env file holds only these names (deploy.py refuses others). They reach the
notify hook, not the agent's sandbox.
