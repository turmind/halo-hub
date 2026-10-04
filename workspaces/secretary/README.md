# secretary — 秘书 + 部门 workspace

> English: a "front desk + departments" Halo workspace. One secretary agent keeps a routing table of your other workspaces on the same server and dispatches work to them with the `relay_*` tools; reports flow back automatically.

一个"统一入口"workspace：你只跟**秘书**说话，秘书查 `.halo/INDEX.md` 里的**部门表**，用 `relay_send` 把活派到同一台服务器上对应部门（其他 workspace）的固定 session；部门做完，结论会自动回到秘书这里，由秘书转述。你不用自己在 workspace 之间切换。

## 包含什么

```
.halo/
├── INSTRUCTIONS.md          # 通用原则 + 部门表维护规则 + 托管模式（手动 / 半托管 / 全托管）
├── INDEX.md                 # 部门表（3 行虚构示例，需要你改）
└── agents/
    ├── default/             # 秘书：覆盖内置 default，只带 relay_* + 文件/shell 工具，会派活、收报告、追问、打断、叫停
    ├── ws-builder/          # 子 agent：给新部门从零搭 workspace，并把「部门表新行」交回秘书
    └── backup/              # 子 agent（可选）：把部门 workspace 同步到 S3、核对一致、清退本地目录
```

## 使用要求

- **Halo ≥ 1.5.5，server 模式**。`relay_*` 工具只在 server 里有效（CLI / TUI 里调用会失败），且只给**完全访问（full access）**的 session 开放。
- 各部门 workspace **已经存在于同一台服务器**上（含 `.halo/` 目录）；没有的可以让秘书交给 `ws-builder` 搭。
- 模型：`agents/*/agent.yaml` 里用的是 `aws-bedrock-claude-invoke` + Claude Sonnet / Opus 5.5。换成别的 provider 就改各 `agent.yaml` 的 `model:` 块（`provider` / `id` / `endpoint` 三项必填）。
- `backup` agent 需要本机装好 `aws` CLI 且凭证能写你的桶；不需要备份功能就按下文「不要备份功能」删掉。

## 安装（目前手动）

1. 在目标项目根目录（随便一个空目录即可）里放好这份 `.halo/`：
   ```sh
   cp -r workspaces/secretary/.halo /path/to/your-secretary-project/
   ```
2. 让 Halo server 打开这个目录（admin 里添加 / 切换 workspace）。
3. 之后 `/workspace import` 上线，会替代手动复制这一步。

## 先改这几处

| 位置 | 占位符 / 示例 | 怎么改 |
|------|------|------|
| `.halo/INDEX.md` 部门表 | `research` / `ops` / `archive` 三行虚构示例 | 换成你自己的部门：`workspace` 填真实绝对路径，`agent` 填该 workspace 里真实存在的 agent id（不确定留空），`session` 用 `secretary-<部门>` 风格，`状态` 写 启用 / 禁用，`托管模式` 写 手动 / 半托管 / 全托管 |
| `.halo/INSTRUCTIONS.md` 第 2 节 | `/path/to/workspaces` | 你放各部门 workspace 的父目录；新部门默认建在它下面 |
| `.halo/INSTRUCTIONS.md` 第 2 节、`agents/default/AGENT.md`「备份 / 清退到 S3」、`agents/backup/AGENT.md` | `<your-bucket>`、`<backup-prefix>` | 你的 S3 桶名和备份前缀（三处保持一致） |
| `agents/ws-builder/AGENT.md` 「输入」一节 | `/path/to/workspaces/<英文短名>` | 和上面的部门 workspace 根目录一致 |
| 各 `agent.yaml` 的 `model:` | Bedrock / us-east-1 公共端点 | 按你实际可用的 provider 调整 |

### 不要备份功能

删掉 `.halo/agents/backup/`；把 `agents/default/agent.yaml` 里 `team:` 的 `backup` 去掉；删除 `agents/default/AGENT.md` 的「备份 / 清退到 S3」一节；`INSTRUCTIONS.md` 第 2 节里"部门清退"和"部门 workspace 备份"两条按需删改。

## 它是怎么工作的（速查）

- **派活**：`relay_send(workspace, session_id, agent_id, message)`。每个部门一个固定 session，不存在会自动建；busy 时消息排队。
- **收报告**：部门做完，`[Relay report · …]` 自动进秘书 session；被截断时用 `relay_read` 拿全文；`[RELAY TARGET ABORTED …]` 表示部门出错中断。
- **追问 / 打断 / 叫停 / 看进度**：`relay_send`（追问）、`relay_interrupt`（硬打断）、`relay_stop`、`relay_read` / `relay_list`。
- **新部门**：`start_session(agent_id="ws-builder", …)` 搭建，拿回「部门表新行」后由秘书写进 `INDEX.md`。
- **文件交付**：部门把文件留在自己目录并在回报里给绝对路径，秘书再用 `MEDIA:<路径>`（`send-file` skill）转发。
- **未知需求**：表里没有对应部门就问用户，不猜路径、不替部门干活。

## 不包含

内置 agent / skill（`executor`、`send-file`、`cron` 等）由接收方的 server 自带，不在包里；`USER.md`、`memory/`、会话与日志同样不含——在你自己的环境里重新积累。
