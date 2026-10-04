# web-search

实时联网搜索 skill，两档：

- **fast**（默认）：Amazon Nova 2 Lite `nova_grounding`，约 3 秒，便宜，日常查询用。
- **deep**（`--deep`）：Bedrock Mantle 上的 OpenAI GPT-5.6 `web_search`，约 20–40 秒，token 消耗大；多轮检索、一手来源、逐条引用，用于核实重要事实。

Real-time web search for Halo agents — fast gear (Nova grounding) and deep gear (GPT-5.6 web_search on Bedrock Mantle).

## 要求

- 机器上有 AWS 凭证（boto3 默认凭证链），账号开通了对应的 Bedrock 模型访问：
  - fast：`us-east-1` 的 Nova 2 Lite；
  - deep：`us-east-2` 的 Bedrock Mantle（`openai.gpt-5.6-luna` / `openai.gpt-5.6-sol`）。
- Python 3 + `boto3`；deep 档另需 `pip3 install --user aws-bedrock-token-generator`。
- 不需要配置 API key，脚本里没有密钥。

## 安装

Halo 自带同名内置 skill（`~/.halo/global/skills/web-search/`）。这里的副本用于单独分发，或在某个 workspace 里覆盖内置版本：

```bash
cp -r skills/web-search <workspace>/.halo/skills/
```

然后在 agent 的 `agent.yaml` 的 `skills:` 里列出 `web-search`。SKILL.md 会优先用 `<workspace>/.halo/skills/web-search/search.py`，没有再用全局那份。
