# agentcore-deploy

把一个 Halo workspace 部署到 **Amazon Bedrock AgentCore Runtime**：容器里跑 `halo agentcore`，workspace 放在 EFS 上，一个 job 配置对应一个 runtime。

- **基础部署**：选择协议。`a2a` 是给其他 Halo 服务器调用的 A2A remote；`http` 是 `POST /invocations`，每次运行的结果可以推送到 IM。
- **定时附加功能**（仅 `http`）：把本地 cron 任务迁到 EventBridge Scheduler，到点直接调用 `InvokeAgentRuntime`，中间不经过 Lambda。

Deploy a Halo workspace to Amazon Bedrock AgentCore Runtime — English summary at the end.

## 依赖

- **Halo ≥ 2.0.2**：镜像里的 `halo agentcore` 需要支持 `/invocations` 和 session dirs。
- 执行部署的机器需要：
  - Python 3 + `boto3`，只用标准库和 boto3；
  - 目标账号的 AWS 凭证；
  - docker buildx，并配好 arm64 builder；
  - `sync` / `gc` 阶段：能跑 `docker run --privileged --network host`，并且网络能到 runtime 子网里 EFS 挂载点的 2049 端口。宿主机上不用装 NFS 客户端或 efs-utils，也不用 sudo。
  - 执行者的 AWS 身份要对本次部署的 EFS 有 `elasticfilesystem:ClientMount`、`ClientWrite`、`ClientRootAccess` 权限（来自执行者自己的身份策略：FS 策略里只放行 runtime 的执行角色，对同账号的其他身份只做两条 Deny）。
- AWS 侧需要事先准备：VPC 私有子网，能路由到 Bedrock 和要推送的 IM API。

其余资源都由 `deploy.py` 新建：每次部署一个专属的加密 EFS，外加挂载点、EFS SG、FS 策略、access point、runtime SG、IAM 角色、ECR 仓库、schedule group。已有资源一律不改。EFS 本身没有固定费用，挂载点也不收费。

## 文件

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 给 agent 的操作说明 |
| `scan.py` | 只读的依赖扫描：blocker、路径、IAM action、数据大小、推送渠道 |
| `deploy.py` | 分阶段部署：`scan` `card` `infra` `image` `runtime` `sync` `test` `status` `gc` `destroy` `schedule` |
| `notify.py` | 打进镜像的 IM 推送脚本，由 Halo 的 notify hook 调用 |

## 一、基础部署

### 选择协议

| `protocol` | serverProtocol | 端口 | 调用方 | 结果去向 |
|---|---|---|---|---|
| `a2a` | A2A | 9000 | 配了 `auth: sigv4` remote 的 Halo 服务器，或任何 A2A 客户端 | 调用方（A2A task） |
| `http` | HTTP | 8080 | 能签名 `InvokeAgentRuntime` 的任何东西：脚本、EventBridge Scheduler | HTTP 响应；配了 `notify` 时还会推送 IM |

**一个镜像，一条命令 `halo agentcore`。** 选哪种协议，只决定 runtime 的 serverProtocol 和端口。进程本身两套路由都提供，AgentCore 只转发它那种协议的路径。同一个 workspace 想两种方式都能调，就写两份配置、部署两个 runtime（用同一个镜像），不做混合 runtime。镜像的 PID 1 是 `tini`，`halo agentcore` 跑在它下面：agent 的 shell 用 `setsid` / `nohup … &` 起的进程被托孤后由 tini 回收，不会积成僵尸（不加 `-g`，SIGTERM 由 front 自己转给 worker）。

`a2a` 需要 `.halo/agent-card.json`。`deploy.py card` 会打印一份草稿，确认后保存。workspace 不方便写的话，可以用 `agent_card:` 指向 workspace 外的文件，`sync` 时会注入成 `.halo/agent-card.json`。

### 配置

job 配置放在被部署的 workspace **之外**，例如 `~/agentcore-jobs/<name>.yaml`。原因是配置里会写密钥文件的路径。

```yaml
name: coach-http                 # 小写字母、数字、-，2–31 位；runtime / 角色 / access point 都用它命名
workspace: /home/me/english-agent
protocol: http                   # a2a | http
region: ap-northeast-1
data: none                       # none | all | [路径, session:<id>]，见“数据”一节
network:
  vpc: vpc-…
  subnets: [subnet-…, subnet-…]  # 每个子网所在 AZ 建一个 EFS 挂载点
  # sync_sg: sg-…                # 执行 sync 的主机的 SG；不写则从 EC2 实例元数据读（该主机只有一个 SG 时）
notify:                          # 仅 http，可选
  env_file: ~/agentcore-jobs/coach.env
observability:                   # 可选：OTLP 上报
  endpoint: http://<collector>:4318
  service_name: coach-http
  headers: "authorization=Bearer ${OTEL_TOKEN}"   # ${VAR} 的值从 headers_file 读取
  headers_file: ~/agentcore-jobs/otel.env
apt: [file]                      # scan 提示缺的 Debian 包
iam:
  allow_actions: []              # scan 找到、确定要授予的额外 action
  ignore_actions: []             # scan 找到、有意不授予的 action
halo_version: 2.0.2              # 或 halo_tgz: <本地 tgz 路径>
builder: arm64builder
```

其他可选项：

- `access`：默认 `workspace`，对应 `HALO_A2A_ACCESS`，agent 的 shell 跑在 bwrap 沙箱里。也可以设成 `readonly`（只读），或 `full`（不用沙箱）。
- `runtime_name`：默认 `halo_<name>`。
- `ecr_repo`：默认 `halo-agentcore`。
- `lifecycle.idle` / `lifecycle.max_lifetime`：默认 60 / 28800 秒。
- `env`：额外的 runtime 环境变量。
- `network.runtime_sg` / `network.ap_root` / `network.mount_ip`（sync 用哪个挂载点 IP）。
- 旧配置里的 `network.efs` / `network.efs_sg` 已移除，留着会直接报错。

### 阶段

每个阶段都先加 `--dry-run` 跑一遍。dry-run 不改任何东西，只打印两类内容：每个 AWS 请求（已用 botocore 模型校验）和每份 IAM 策略（已过 Access Analyzer）。

```bash
python3 deploy.py scan    -c job.yaml            # 依赖报告
python3 deploy.py card    -c job.yaml            # a2a：打印卡片草稿
python3 deploy.py infra   -c job.yaml --dry-run  # EFS、挂载点、两个 SG、access point、执行角色、FS 策略
python3 deploy.py image   -c job.yaml --dry-run  # 构建并推送 arm64 镜像
python3 deploy.py runtime -c job.yaml --dry-run  # 创建 / 更新 runtime
python3 deploy.py sync    -c job.yaml --template --dry-run   # 复制到 <ap>/.template
python3 deploy.py test    -c job.yaml            # http：同步调用一次；a2a：SendMessage blocking
python3 deploy.py status  -c job.yaml            # 资源 id + 最近日志
python3 deploy.py gc      -c job.yaml --older-than 30         # 列出闲置的 session 目录和超过 1 小时的 .tmp-* 半截拷贝，加 --apply 才删除
python3 deploy.py destroy -c job.yaml --dry-run  # 删除 schedule、runtime、角色、runtime SG
```

部署状态记录在配置旁边的 `<name>.state.json`（权限 0600），只包含本工具创建的资源 id。

`destroy` 的顺序是 schedule → runtime → 角色 → runtime SG。加 `--purge-data` 时，runtime 之后先删 access point → 挂载点 → EFS（连同上面的全部数据），再删角色，然后先删 EFS SG、再删 runtime SG（EFS SG 的规则引用着 runtime SG）。不加 `--purge-data` 时 EFS 保留，FS 策略里先去掉这个角色再删角色。删 SG 之前要等 AgentCore 的 ENI 释放（runtime 删掉后还会挂很久，实测超过 2 小时），最多等 15 分钟；超时就在输出里列出 ENI，SG 留着，之后再跑一次 `destroy` 即可。ECR 仓库和镜像不删。

### 数据

第一次 `sync` 之前先跑 `scan`，把 **DATA** 一节（顶层目录及大小）给用户看，**由用户决定**带哪些数据：

- `none`（默认）：只带 agent 配置，即 `.halo/agents`、`skills`、`prompts`、INSTRUCTIONS / INDEX / USER.md、agent card，再加 job prompt 里提到的文件。
- `all`：整个 workspace。
- 列表：配置加上列出的路径；`session:<id>` 表示带上某个会话的历史，仅限定时附加功能。

不管怎么选，下面这些都不带：

- `.halo/{sessions,tmp,logs,secrets}`；
- `*.db*`、lock / lease 文件；
- `node_modules`、`__pycache__`、`.ssh` / `.aws` / `.gnupg`；
- `.halo/settings.yaml`（里面可能有 provider 的 key）；
- 看起来像密钥的文件：`.env*`、`*.pem` / `*.key`、`id_*`、`credentials` 等。

**成本**：每个新的调用方（新的 runtime session id）都会从 `.template` 完整复制一份。所以 EFS 上的占用约等于数据大小 × 调用方数量，而且新调用方的第一次调用要等复制完成。`sync --dry-run` 会列出每个文件和总大小。

## 二、定时附加功能（仅 `protocol: http`）

```yaml
schedule:
  cron_job: cron-…               # 本地任务：prompt、agent、会话、时间表都从它读取
  # session_id: job-<name>-000…  # runtime session id，也就是这个 job 在 EFS 上的目录（≥ 33 位）
  # expression / timezone        # 覆盖自动转换出来的 cron 表达式
notify:
  env_file: ~/agentcore-jobs/coach.env
data:
  - notebook.md
  - session:cron-cron-…          # 带上本地 cron 会话，换到 AgentCore 后接着聊
```

- **A2A runtime 不能定时**：EventBridge Scheduler 发不了 `A2A-Version` 请求头，Halo 的 A2A 端点不带这个头会拒绝请求。
- `sync`（不加 `--template`）写的是 job 自己的目录。prompt 写成 `.halo/jobs/<name>.md`，里面的宿主机路径改写为 `/workspace`。
- `schedule --test-in N`：创建一个 N 分钟后触发的一次性 `at()`，触发后自动删除。先用它确认推送能到。
- `schedule`：创建周期性 schedule，**默认 DISABLED**，加 `--enable` 才启用。上线后记得停掉本地的 cron 任务，否则两边都会触发。
- 每次触发发送 `{"promptFile", "session", "id": "<schedule-arn>@<scheduled-time>", "async": true}`。Scheduler 重试时 id 不变，所以只会运行一次。

**技术债**：带会话（`session:<id>`）时，`sync` 会生成一个只含该会话 `agent_sessions` 行的最小 `.halo/halo.db`。具体做法是：取源库快照，删掉其他所有行，再执行 `VACUUM`，清掉空闲页，免得别的会话内容残留其中被带过去；源库的 schema 版本比镜像里的 Halo 新时直接拒绝。这个库只写进 job 自己的目录，不会进 `.template`。Halo 没有会话导入功能，这里是 skill 代写 halo.db；正确的修法应该在 Halo 本体（`halo sessions import` 或打开时自动认领），不在 skill 里。

## 推送渠道（http）

`/invocations` 的每次运行结束后，notify.py 会把最终回复和 `MEDIA:` 附件推送到所有配齐了变量的渠道。

| 渠道 | 变量 | 说明 |
|---|---|---|
| 飞书 / Lark | `FEISHU_APP_ID` `FEISHU_APP_SECRET` `FEISHU_RECEIVE_ID`（`FEISHU_RECEIVE_ID_TYPE`、`FEISHU_API_BASE` 可选） | 文本 + 文件 |
| Slack | `SLACK_BOT_TOKEN` `SLACK_CHANNEL` | 文本 + 文件 |
| Telegram | `TELEGRAM_BOT_TOKEN` `TELEGRAM_CHAT_ID` | 文本 + 文件 |
| 企业微信群机器人 | `WECOM_WEBHOOK_KEY` | 文本 + 文件 |
| 企业微信智能机器人 | `WECOM_BOT_ID` `WECOM_BOT_SECRET` `WECOM_CHAT_ID`（`WECOM_CHAT_TYPE` 可选） | 每个机器人只能保持一条长连接：用一个没有任何 Halo 服务器连着的机器人，否则会把对方挤下线 |
| 微信 | — | AgentCore 上无法主动推送 |

变量写在 `notify.env_file` 指向的文件里（权限 0600），只接受上表这些变量名。

## 安全

- **最小权限**：执行角色只授予 scan 找到的权限：
  - ECR 拉取本仓库镜像；
  - 写本 runtime 的日志；
  - 挂载本 access point（条件 `elasticfilesystem:AccessPointArn`）；
  - 调用 agent 实际使用的 Bedrock 模型（推理配置文件和它路由到的 foundation model）。
  
  其他 action 必须在 `iam.allow_actions` 里明确列出，否则部署中止。Scheduler 角色只能调用这一个 runtime，trust 限定为这个 schedule group。所有策略写入前都会过 IAM Access Analyzer。
- **跨 runtime 隔离**：每个 runtime 有专属的 EFS、access point 和执行角色。EFS 的 FS 策略只有三条：
  - `DenyNonTls`：非 TLS 一律拒绝；
  - `DenyWithoutAccessPoint`：不经 access point 的挂载一律拒绝（同账号权限再大也不能挂 FS 根目录）；
  - `AllowRuntimeRoleViaAP`：只放行本 runtime 的执行角色，且必须经它自己的 access point。

  EFS SG 只放行本 runtime 的 SG 和 sync 主机的 SG。runtime 之间互相读不到对方的数据。`runtime` 阶段每次都会比对 FS 策略，角色重建后自动修正。
- **同一个 runtime 内**：AgentCore 的每个 session 是独立的 microVM，但 runtime 挂的 EFS（同一个 access point）是所有 session 共享的。Halo 给每个 runtime session id 一个独立目录，bind 挂载在 `/workspace`，并把公共根目录卸掉；agent 的 worker 以 uid 1000 运行，不带任何 capability。这样能防住会话之间的**误读**，但防不住**蓄意读取**：
  - 调用方可以让 agent 写一个 NFS 客户端，连 microVM 本地回环上的 EFS 代理；
  - 或者从 microVM 元数据服务（MMDS）拿到执行角色凭证，再直接连 2049。

  这两条路都能读到同一个 runtime 里其他会话的目录。
- **推荐做法**：要硬隔离，最简单的办法是**拆 runtime**。每个 runtime 有自己独立的 EFS / access point 和执行角色，本 skill 每次部署就是这么建的。互不信任的调用方，或者需要硬隔离的场景，分开部署成不同的 runtime。
- **未来可选的加固方向**（未实现）：把 worker 放进独立的 network namespace。实测：microVM 内核没有 tun 设备，slirp4netns 用不了；但 `unshare --user --net`（只有 lo）配合一个经 unix socket 转发、只放行 `*.amazonaws.com:443` 的 CONNECT 代理可行。这样 Bedrock 能通，回环上的 NFS 代理、MMDS 和 2049 都不通。
- **`InvokeAgentRuntimeCommand` 等于 root shell**：能调这个 API 的身份可以读写该 runtime 的全部数据，也能拿到执行角色凭证。只授予运维身份。
- **密钥**：
  - 渠道凭证和 collector token 都放在 0600 文件里，由 deploy.py 读出、写入 runtime 环境变量，dry-run 和日志里一律打码，不会写进配置或 workspace。
  - 渠道凭证只给 notify hook 用，不会进入 agent 的进程和 sandbox。
  - `OTEL_*`（包括 headers）会传给 worker，用于上报。
- **不复制的内容**：`.halo/settings.yaml`、sessions、数据库、密钥类文件始终不带，见“数据”一节。

## 可观测性

配置 `observability.endpoint` 和 `headers` 后，runtime 会把 trace / metric / log 以 OTLP 上报到这个 collector。header 里的 token 用 `${VAR}` 占位，实际值从 `headers_file`（权限 0600，`KEY=VALUE` 格式）读取。collector 的 SG 需要放行 runtime 所在子网。

## 打包

```bash
node scripts/pack.mjs skills/agentcore-deploy   # → dist/skill-agentcore-deploy-<version>.zip
```

`tests/` 和 `__pycache__/` 不会打进 zip。

---

## English

Deploys one Halo workspace as one Amazon Bedrock AgentCore runtime (`halo agentcore` in an arm64 container, workspace on EFS). Needs **Halo ≥ 2.0.2**, Python 3 + boto3, docker buildx (arm64), and for `sync` / `gc` docker (`--privileged --network host`) with a route to the EFS mount targets' 2049 plus an identity allowed `elasticfilesystem:ClientMount` / `ClientWrite` / `ClientRootAccess` on the deploy's EFS.

- **Base deploy, protocol `a2a` or `http`.** One image, one command `halo agentcore`; the protocol only picks serverProtocol (A2A :9000 / HTTP :8080). The process serves all routes and AgentCore forwards only its protocol's paths. `tini` is the image's PID 1 (reaps orphans of the agent's shell; no `-g`, the front forwards SIGTERM to the worker itself). `a2a` needs an agent card (`deploy.py card` drafts it).
- **Schedule add-on (http only).** EventBridge Scheduler calls `InvokeAgentRuntime` directly. A2A runtimes can't be scheduled because Scheduler can't send the `A2A-Version` header.
- **Phases**: `scan` → `card` (a2a) → `infra` → `image` → `runtime` → `sync --template` → `test`, then `status` / `gc` / `destroy`; `schedule [--test-in N | --enable]` for the add-on. Use `--dry-run` first every time: it validates every request and policy and changes nothing.
- **Data**: the user picks `none` / `all` / a path list before the first sync. Each new caller gets a full copy of the template, so EFS holds size × callers. Sessions, databases, `.halo/settings.yaml` and secret-looking files never travel.
- **Notify**: Feishu / Slack / Telegram / WeCom env vars from a 0600 `notify.env_file`. Optional OTLP `observability.endpoint` + `headers` (token from `headers_file`).
- **Isolation**: every deploy gets its own encrypted EFS (mount targets, EFS SG admitting only the runtime + sync host, access point, execution role) and a 3-statement FS policy — deny non-TLS, deny without an access point, allow only this runtime's role through its own access point — so runtimes can't read each other. Inside one runtime the per-session `/workspace` bind + uid-1000 worker stop accidental reads, not deliberate ones: the agent could talk to the microVM's loopback NFS proxy, or take the role credentials from MMDS and reach 2049. Callers that must not see each other belong in separate runtimes. Future hardening (not built): worker in its own netns (no tun in the microVM, so no slirp4netns; `unshare --user --net` + a unix-socket CONNECT proxy allowing `*.amazonaws.com:443` works). `InvokeAgentRuntimeCommand` is a root shell — grant it to operators only.
- **Destroy**: schedule → runtime → roles → runtime SG; `--purge-data` also access point → mount targets → EFS (all data) after the runtime, and the EFS SG before the runtime SG. SG deletes wait up to 15 min for AgentCore's ENIs (seen lingering 2 h+ after the runtime is gone), then report and leave the SG for a later run.
- **Tech debt**: `session:<id>` makes sync write a pruned, VACUUMed `halo.db` holding just that session's row. Halo has no session import, so the skill writes halo.db itself; the real fix belongs in Halo (`halo sessions import` / adopt on open), not in the skill.
