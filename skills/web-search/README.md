# web-search

实时联网搜索 skill，**运行在 AWS Bedrock 上**，两档：

- **fast**（默认）：Amazon Nova 2 Lite + Web Grounding（`nova_grounding`），约 3 秒，便宜，日常查询用。
- **deep**（`--deep`）：Bedrock Mantle 上的 OpenAI GPT-5.6 `web_search`，约 5–40 秒，token 消耗大；多轮检索、一手来源、逐条引用，用于核实重要事实。

Real-time web search for Halo agents on AWS Bedrock — fast gear (Nova grounding) and deep gear (GPT-5.6 web_search on Bedrock Mantle). Needs AWS credentials with Bedrock access.

## 依赖

- 机器上有 AWS 凭证（boto3 默认凭证链）。不需要 API key，脚本里没有密钥。
- Python 3 + `boto3`；deep 档另需 `pip3 install --user aws-bedrock-token-generator`。

## IAM 权限

| 档 | 需要的权限 |
|---|---|
| fast | `bedrock:InvokeModel`（`us.amazon.nova-2-lite-v1:0` 推理配置文件）+ `bedrock:InvokeTool`（资源 `system-tool/amazon.nova_grounding`）；或托管策略 `AmazonBedrockFullAccess`。若 SCP 用 `aws:RequestedRegion` 限制区域，需放行 `unspecified`。Web Grounding 另行计费 |
| deep | `bedrock-mantle:CreateInference` + `bedrock-mantle:CallWithBearerToken`；或托管策略 `AmazonBedrockMantleInferenceAccess` |

没有权限时脚本报 AccessDenied / 凭证错误，agent 会直接说明缺什么，不会重试。

## 区域

| 档 / 模型 | 可用区域 | 默认 |
|---|---|---|
| fast（Nova 2 Lite grounding，仅美国区域；`global.` 配置文件不支持 grounding） | us-east-1 / us-east-2 / us-west-2 | us-east-1 |
| deep · luna（默认模型） | us-east-1 / us-east-2 / us-west-2 | us-west-2 |
| deep · sol（`--model sol`） | us-east-1 / us-east-2 | us-east-1 |

参考延迟（2026-10 实测，单次简单问题）：fast us-east-1 ≈ 3.7 s、us-east-2 ≈ 10 s、us-west-2 ≈ 2.1 s；luna us-west-2 3–8 s、us-east-2 3–7 s、us-east-1 21–57 s；sol us-east-1 ≈ 15 s、us-east-2 ≈ 6 s。

区域在 Halo 的 **Settings → Skills → web-search** 里配置（`fast_region`、`deep_region`，留空用上表默认值）。`deep_region` 配成 sol 不支持的区域时，sol 调用自动改用 us-east-1，并在 stderr 提示。直接跑脚本时也可以用环境变量 `WEB_SEARCH_FAST_REGION` / `WEB_SEARCH_DEEP_REGION`。

## 安装

Halo 自带同名内置 skill（`~/.halo/global/skills/web-search/`）。这里的副本用于单独分发，或在某个 workspace 里覆盖内置版本：

```bash
cp -r skills/web-search <workspace>/.halo/skills/
```

然后在 agent 的 `agent.yaml` 的 `skills:` 里列出 `web-search`。SKILL.md 会优先用 `<workspace>/.halo/skills/web-search/search.py`，没有再用全局那份。
