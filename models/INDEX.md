# Model provider census: where to look and how to probe

The maintainer runbook for refreshing the 13 provider yamls in this folder.
Halo's bundled copies (`packages/server/templates/models/` in halo-agent) must
stay byte-identical with these. `scripts/pack.mjs models` and `halo models install`
read only `*.yaml`, so this file never ships in a release zip.

## Per provider: sources

| provider yaml | wire (runtime) | new-model / spec source | deprecation source | model-list API (status field) |
|---|---|---|---|---|
| `aws-bedrock-claude-invoke` · `aws-bedrock-mantle` · `aws-bedrock-openai` | Bedrock InvokeModel / Mantle Responses / Mantle chat | model cards: docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html | docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html (Active / Legacy + EOL) | `aws bedrock list-foundation-models --region <r>` → `modelLifecycle.status`; run it for every region in `endpointPresets` |
| `deepseek` | OpenAI chat | api-docs.deepseek.com/quick_start/pricing · /updates | api-docs.deepseek.com/updates | `GET https://api.deepseek.com/models` |
| `doubao` | OpenAI chat + `thinking:{type}` | model list: `https://www.volcengine.com/api/doc/getDocDetail?LibraryID=82379&DocumentID=1330310&type=online` · release notes: `…&DocumentID=1159178…` (JSON; read `Result.MDContent`; the HTML pages render by script) | `…&DocumentID=1350667…` (模型下线公告: EOM / EOS per batch) | `GET https://ark.cn-beijing.volces.com/api/v3/models` → `status` (`Retiring` / `Shutdown`) + `token_limits` (context / max input / max output) |
| `hunyuan` | OpenAI chat + `reasoning_effort` | release posts on tencent.com; HF `tencent/Hy*-preview` `config.json` (`max_position_embeddings`) | cloud.tencent.com/document/product/1729/131925 (fetch with `curl --compressed`; the page is served gzipped) | `GET https://tokenhub.tencentmaas.com/v1/models` → `status` (`online`); a model that drops off the list may still answer |
| `kimi` | OpenAI chat | platform.moonshot.cn/docs/models · per-model quickstart pages | the same models page ("已下线 / 将下线") | `GET https://api.moonshot.cn/v1/models` (also returns context length and supported efforts) |
| `minimax` | Anthropic Messages | platform.minimaxi.com/docs/guides/models-intro ("历史模型" = older generation) | the same page | `GET https://api.minimaxi.com/v1/models` |
| `qwen` | Anthropic Messages (`/apps/anthropic`) | help.aliyun.com/zh/model-studio/anthropic-api-messages (supported-model list) · the text-generation model guide (推荐模型) | help.aliyun.com model-deprecation page | none on the Anthropic endpoint (`/v1/models` → 404); `GET https://dashscope.aliyuncs.com/compatible-mode/v1/models` |
| `zhipu` | OpenAI chat (`/api/paas/v4`) | docs.bigmodel.cn/cn/guide/start/model-overview.md · /cn/update/new-releases.md (index at docs.bigmodel.cn/llms.txt) | release notes (no separate deprecation page) | `GET https://open.bigmodel.cn/api/paas/v4/models` |
| `mimo-token-plan-china` | Anthropic Messages | mimo.mi.com/llms-full.txt (model table + deprecation banner) | mimo.mi.com/docs/zh-CN/updates/deprecate | none (token-plan `/anthropic/v1/models` → 404) |

**Skipped: `anthropic` and `openai`.** These two generic providers hold
placeholders only, for users who point them at their own gateway. The census
skips them entirely: no doc checks, no probes, no edits. New Claude and GPT
models are caught through the three `aws-bedrock-*` providers above.

If the official docs say nothing, run a web search, then fetch the cited page
and confirm the figure before changing a yaml on it. A figure that only a
third-party page states stays unverified, noted in the yaml comment as
`search-only, unconfirmed: <url>`.

## Minimal live probe (one per added model)

Load keys into the probing process only. Never echo them, log them or write
them to disk. Per model:

1. Plain call: `"Reply with just: OK"`, `max_tokens` around 2K.
2. Each thinking state the yaml exposes: on with every effort preset, and off.
   Check the reasoning tokens or thinking block. A bad value is either a 400
   or silently ignored; note which.
3. Image: a 64×64 solid-red PNG as a base64 data URL / Anthropic `image` block.
   Ask "what single colour fills this image?". Set `image: true` only on a
   correct answer.
4. Tool call: one no-arg function. Expect `finish_reason: tool_calls` or
   `stop_reason: tool_use`.
5. Caching: send a system prompt over 4K tokens twice. Look for cached tokens on
   turn 2. For Anthropic-shape endpoints, also send `ttl: '1h'` and check
   whether `usage.cache_creation` reports a 1h bucket; accepted is not the same
   as honoured.
6. Output cap: `max_tokens` = claimed max, then max + 1. A 400 at max + 1
   confirms the cap. Some gateways (Hunyuan) never reject, which proves nothing.

`ModelNotOpen` (Ark) or an equivalent "not activated" error means the account
can't probe the model. Don't add it until someone with access probes it.

## Yaml rules

- **Context**: `contextWindow` = min(272000, true max); `maxContextWindow` =
  the true max (the official figure, or the model-list API's
  `token_limits.max_input_token_length` when that is lower than the context
  window); `compressAt: 0.9`. When no max can be verified,
  `maxContextWindow = contextWindow`.
- **Defaults**: effort `xhigh` where offered, else `high`. Cache TTL `1h` where
  it is actually honoured, else the only TTL. Verbosity `medium`.
- **Order**: newest generation first; `defaultModelId` = the flagship of the
  newest generation the account can call. Endpoint presets: default first, then
  by region (the `aws-bedrock-mantle` order is E1 / W2 / E2). Use per-model
  `endpoints:` only where the provider really splits models by region.
- **Dedupe**: one entry per callable id. Don't add dated snapshot aliases
  (`-0902`, `-2026-05-26`) next to their rolling id.
- **Retirement**: remove a model only after its published shutdown date. Before
  that, keep it at the tail under
  `# --- deprecated: retires YYYY-MM-DD (<url>) — remove after cutoff ---` and
  suffix its `displayName` with `(deprecated YYYY-MM-DD)`. A model that is only
  superseded (no date) stays at the tail with a comment saying so.
- **Revision**: bump `revision: YYYYMMDDNN` on every edit, keep the bundled
  and hub copies byte-identical, and update the revisions table in
  `../README.md`.
