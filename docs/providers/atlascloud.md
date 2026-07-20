# Atlas Cloud

Atlas Cloud is an OpenAI-compatible API-key provider. Gini talks to
`https://api.atlascloud.ai/v1` and authenticates with a Bearer key.

## Step 1 - Get an API key

1. Sign in to the [Atlas Cloud console](https://www.atlascloud.ai/console/api-keys).
2. Create an API key and copy it.
3. Check the live model catalog in Atlas Cloud before pinning a model for
   production use.

## Step 2 - Set the key

Gini reads the key from the `ATLASCLOUD_API_KEY` environment variable. Set it in
your shell or in `~/.gini/secrets.env` for persistence:

```bash
# ~/.gini/secrets.env  (created mode 0600)
ATLASCLOUD_API_KEY=ak-...
```

The web Add Provider form writes this for you.

## Step 3 - Configure the provider in Gini

### CLI

```bash
gini provider set atlascloud qwen/qwen3.5-flash
```

The default model is `qwen/qwen3.5-flash`. You can also pin another Atlas Cloud
chat model, such as `deepseek-ai/deepseek-v4-pro`. The base URL defaults to
`https://api.atlascloud.ai/v1`; override it only for a compatible proxy with
`--base-url`.

### Web

Open **Settings -> Add provider -> Atlas Cloud**, paste the key, and pick or type
an Atlas Cloud model ID.

## Re-authentication

Atlas Cloud is an API-key provider, so a credential failure surfaces the
provider error and links to **Settings -> Providers** to paste a new key. Rotate
keys from the Atlas Cloud console when needed. See ADR
[provider-reauth-guidance.md](../adr/provider-reauth-guidance.md).
