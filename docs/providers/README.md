# Model providers

Gini reaches chat models through pluggable providers. Each page below covers how
to obtain credentials, install any prerequisite tooling, and configure the
provider in Gini (both the CLI and the web Add Provider form).

| Provider | Auth | How credentials are supplied | Setup guide |
|---|---|---|---|
| OpenAI | API key | `OPENAI_API_KEY` | [openai.md](openai.md) |
| Anthropic (first-party Claude) | API key | `ANTHROPIC_API_KEY` | [anthropic.md](anthropic.md) |
| Amazon Bedrock | AWS SigV4 | AWS access key + secret you enter (stored in `~/.gini/secrets.env`) | [bedrock.md](bedrock.md) |
| Azure OpenAI | API key / Entra | `AZURE_OPENAI_API_KEY` | [azure.md](azure.md) |
| OpenRouter | API key | `OPENROUTER_API_KEY` | [openrouter.md](openrouter.md) |
| DeepSeek | API key | `DEEPSEEK_API_KEY` | [deepseek.md](deepseek.md) |
| Atlas Cloud | API key | `ATLASCLOUD_API_KEY` | [atlascloud.md](atlascloud.md) |
| Codex (OpenAI OAuth) | OAuth / CLI | `~/.codex/auth.json` (no key) | [codex.md](codex.md) |
| Local (OpenAI-compatible) | none / optional key | `GINI_LOCAL_API_KEY` (optional) | [local.md](local.md) |

`gini setup`'s interactive picker covers **every** provider above, prompting for
whatever each one needs (an API key, the AWS access key + secret for Bedrock, the
resource endpoint and deployment for Azure, the base URL for Local). You can
also use `gini provider set …` (each page has the exact command) or the web
**Settings → Add provider** form for scripted or non-interactive setup.

When a credential fails mid-chat, Gini surfaces a provider-named note: API-key
providers link to the Settings key form, Bedrock prompts you to re-enter your AWS
keys, and Codex opens its re-authentication steps. See ADR
[provider-reauth-guidance.md](../adr/provider-reauth-guidance.md).
