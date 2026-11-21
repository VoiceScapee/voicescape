# Using Otari

[Otari](https://otari.ai) is an open-source LLM gateway with an OpenAI-compatible API.
An open agentic website can use it as its LLM router. Mozilla runs a hosted Otari, and
you can also run one yourself. For other providers, see [LLM providers](README.md).

Which setup works depends on how Otari is used:

| Router | Static bundle (`--static-bundle`) |
|---|---|
| Hosted Otari (`otari.ai`) | Does not work: hosted Otari blocks browser calls |
| Self-hosted Otari | Works, if Otari allows the site's origin |

## How the page reaches the LLM

In the `⚙ BYOK / router settings` panel, the `API key`, `Model` and `Router base URL`
fields decide where LLM requests go. The browser sends each request to the Router base URL.

**Static bundle.** `nsdeploy`'s `--static-bundle` builds plain files with no server and no relay.
The browser calls the router itself, so the router must allow browser calls (CORS).
An empty Router base URL means the `--upstream` URL given at build time.

OpenAI allows browser calls, which is why the static bundle in the
[Quickstart](../quickstart.md#manually-generate-a-website-bundle) works with it. Hosted Otari
does not.

## Hosted Otari (otari.ai)

- The base URL is `https://api.otari.ai/api/v1`. Plain `/v1` returns 404.
- Hosted Otari does not allow browser calls. If Router base URL points straight at Otari,
  the chat shows `⚠️ Failed to fetch` and the browser console shows CORS errors. A correct
  key and URL don't help.
- To use Otari from a static site, run it yourself as shown below.

## Self-hosted Otari with local models

This runs Otari in Docker in front of [Ollama](https://ollama.com) on your machine, so
no LLM provider key is needed.

### 1. Pull a model

```shell
ollama pull gemma4:e4b
```

### 2. Make a key

Make a folder for the Otari config and key:

```shell
mkdir otari
cd otari
```

You make up the Otari key yourself. Otari creates every key listed in its config when
it starts. This command writes a random key to `key.env` without printing it:

```shell
(umask 077; python3 -c "import secrets; print('OTARI_LOCAL_API_KEY=tk-' + secrets.token_urlsafe(48))" > key.env)
set -a; . ./key.env; set +a
```

The key only works on your local Otari. Keep `key.env` out of git.

### 3. Write `config.yml`

```yaml
database_url: "sqlite+aiosqlite:///./otari.db"
default_pricing: true
providers:
  ollama:
    api_base: "http://host.docker.internal:11434"
    models: [gemma4:e4b]
pricing:
  "ollama:gemma4:e4b":
    input_price_per_million: 0
    output_price_per_million: 0
cors_allow_origins:
  # "*" lets any website call Otari from the browser. Each call still needs a valid key.
  # To allow only your own sites, list their exact origins (scheme, host and port) instead.
  - "*"
api_keys:
  local-test:
    secret: ${OTARI_LOCAL_API_KEY}
    user_id: local-test
```

- **`pricing`:** Otari refuses a model with no price (402). Give each local model you
  want to use a zero-price entry like the one above.
- **`cors_allow_origins`:** the origins of pages allowed to call Otari from the browser.
  - `"*"` allows pages on any website. Otari still refuses a call without a valid key.
  - To allow only specific sites, list their exact origins instead: scheme, host and
    port, with no path. `http://localhost:8080` and `http://127.0.0.1:8080` are
    different origins.
  - The [Quickstart](../quickstart.md#manually-generate-a-website-bundle) serves its
    bundle at `http://127.0.0.1:8080`.

### 4. Start Otari

From the folder with `config.yml`, in the shell where you loaded `key.env`:

```shell
export OTARI_CONFIG_YAML="$(cat config.yml)"
docker run --rm --name otari-local --publish 127.0.0.1:8042:8000 \
  --env OTARI_LOCAL_API_KEY --env OTARI_CONFIG_YAML \
  mzdotai/otari:0.36.0 otari serve
```

Otari's base URL is now `http://127.0.0.1:8042/api/v1`. On Linux, `host.docker.internal`
may need `--add-host=host.docker.internal:host-gateway` on `docker run`.

Otari keeps its database inside the container, so it starts empty each time. That's
fine here, because it creates the key from `config.yml` when it starts.

### 5. Point the site at it

Open an agentic website in a browser,
and expand `⚙ BYOK / router settings`:

- API key: the value after `OTARI_LOCAL_API_KEY=` in `key.env`.
- Model: `google/gemma4-e4b` (or `ollama:gemma4:e4b`; both work).
- Router base URL: `http://127.0.0.1:8042/api/v1`

Click `Apply, save & reload`, then chat.

Things to know:

- **Model IDs.** `GET /api/v1/models` lists local models under catalog-style IDs such as
  `google/gemma4-e4b`. It also lists other Ollama models found on the host. Those return
  402 until you add a pricing entry for them.
- **Local models are slow.** A multi-agent turn can take a minute or more.
- **For a public site,** run Otari on a server behind HTTPS, and set Router base URL to
  its address, such as `https://otari.example.com/api/v1`. If `cors_allow_origins` lists
  exact origins, add your site's origin, such as `https://example.com`. Browsers block an
  `https` page from calling a plain `http` address other than `localhost`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Chat shows `⚠️ Failed to fetch`, console shows "blocked by CORS policy" | The browser is calling a router that doesn't allow this page. Hosted Otari never allows it, so use a self-hosted Otari. For self-hosted Otari, add the page's exact origin to `cors_allow_origins` and restart Otari. |
| The site keeps using an old router | The panel saves your setup in the browser. On `localhost` and `127.0.0.1` it is also kept in a cookie shared by every local port for 180 days, so a router saved for another site follows you. Set Router base URL to the router you want, or clear it to use the site's default, then `Apply, save & reload`. |
| 400 `invalid_model` | Use an exact model ID from `GET /api/v1/models`. |
| 402 "No pricing is configured" | Self-hosted: add a `pricing` entry for that model. |
| 404 "Otari serves its API under /api/v1" | The base URL must end in `/api/v1`, not `/v1`. |
| 401 "Invalid API key" | The key is wrong. Self-hosted: check that `OTARI_LOCAL_API_KEY` was set in the shell that ran `docker run`. |

## Get help and share feedback

The Otari developers are on the [Mozilla OSAI Discord](https://discord.gg/AzMfpN3VNS).
Join, select the `agentic-hackathon` role in Channels & Roles, and head to `#otari-ai`.

- **Stuck?** Ask your question in `#otari-ai`.
- **Hit a bug or a rough edge?** Post it in `#otari-ai` or
  [open an issue on GitHub](https://github.com/mozilla-ai/otari/issues). Include what you were
  trying to do, the model you used, and the exact error message.
- **Want to contribute?** Pull requests on the [Otari repo](https://github.com/mozilla-ai/otari)
  are welcome.
