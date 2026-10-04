# 秘书工作区 · 部门索引

秘书派活只看这张表。`workspace` 是 `relay_send` 的 `workspace` 参数，`session` 是 `session_id` 参数（固定命名，不存在时 `relay_send` 会自动建，用 `agent` 列指定的 agent；`agent` 为空则用该 workspace 的默认 agent）。

维护规则见 `.halo/INSTRUCTIONS.md` 第 2 节。

> 📝 **下面三行是虚构的示例，请先改成你自己的部门。** `workspace` 必须是同一台服务器上真实存在、含 `.halo/` 的绝对路径，否则 `relay_send` 会报 not a halo workspace。

| 部门 | 职责 | workspace | agent | session | 状态 | 备注 | 托管模式 |
|------|------|-----------|-------|---------|------|------|------|
| research | 资料调研 / 竞品分析 / 文献整理 | `/path/to/workspaces/research` | `default` | `secretary-research` | 启用 | 示例行：调研类的活归这里 | 手动 |
| ops | 线上运维 / 日常巡检 / 故障排查 | `/path/to/workspaces/ops` | `oncall` | `secretary-ops` | 启用 | 示例行：`oncall` 是该 workspace 自己定义的 agent，`ls <workspace>/.halo/agents` 确认过再填 | 半托管 |
| archive | 历史项目归档 | `/path/to/workspaces/archive` | | `secretary-archive` | **禁用** | 示例行：状态为禁用的部门不派活；`agent` 留空 = 走该 workspace 的默认 agent | 手动 |

## 与各部门的交流记录

给各部门发的需求、进度、待定事项，按部门放在 workspace 根目录的 `<部门>/` 文件夹下，里面怎么组织由秘书定，持续更新。例如（可选，需要跟踪长期需求的部门再建）：
- research：`research/requests.md`（一个文件三段：进行中 / 待办 / 已完成，状态变了就把那一行剪到对应段）
