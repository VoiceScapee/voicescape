# LLM providers

An open agentic website like one generated with `nsdeploy` can talk to its LLM through the
OpenAI Chat Completions API. It sends
`POST <router>/chat/completions` with your key as `Authorization: Bearer <key>`, and it
reads `GET <router>/models` to check the model name.
It requires the provider to allow browser calls (CORS).

## Which providers work

| Provider | Router base URL | Example model | Direct from the browser (static bundle) |
|---|---|---|---|
| [OpenAI](#openai) | `https://api.openai.com/v1` | `gpt-4.1-mini` | Works |
| [OpenRouter](#openrouter) | `https://openrouter.ai/api/v1` | `anthropic/claude-haiku-5.5` | Works |
| [Anthropic](#anthropic) | `https://api.anthropic.com/v1` | `claude-haiku-4-5` | Does not work |
| [LiteLLM, self-hosted](#litellm-self-hosted) | `http://127.0.0.1:4000/v1` | your model alias | Works |
| [Ollama, local](#ollama-local) | `http://127.0.0.1:11434/v1` | `gemma4:e4b` | Local testing only |
| [Otari](otari.md) | `https://api.otari.ai/api/v1` | `alibaba/qwen-3.5-35b-a3b` | Self-hosted Otari only |

To reach Claude models from a static bundle, use OpenRouter or LiteLLM.

## Connecting a site to a provider

**With a static bundle** like the one generated with `nsdeploy`,
the browser calls the provider itself. Build with
`--static-bundle --upstream <router base URL>`, or set Router base URL in the panel to
the provider's URL. This only works for providers that allow browser calls (CORS).

Things to know for every provider:

- **Model check.** If the router lists its models, the panel refuses a model that isn't
  on the list with `Model "X" is not published by this upstream`. If the list can't be
  read, there is no check, so type the exact model ID.
- **Pick a model that makes tool calls.** The front agent hands work to other agents
  through tool calls. A model that answers in plain text instead won't delegate.
- **One harmless console error.** With the router set straight to a cloud provider, the
  console shows a CORS error for `<provider origin>/agent-manifest.json`. nsdeploy checks
  that address, ignores the failure and carries on.
- **Limit your key.** Use a key with a spending limit, and consider revoking it when done.

## OpenAI

- This is nsdeploy's default `--upstream`, so it can be left out when you build the bundle.
- OpenAI allows browser calls, so static bundles work. The
  [Quickstart](../quickstart.md#manually-generate-a-website-bundle) uses it.
- Model IDs look like `gpt-4.1-mini`. The model check uses OpenAI's model list.
- Some newer OpenAI models limit tool calls on Chat Completions. Check OpenAI's docs
  before you pick a model.

## OpenRouter

- Base URL: `https://openrouter.ai/api/v1`.
- Model IDs are `vendor/model`, such as `openai/gpt-4.1-mini` or
  `anthropic/claude-haiku-5.5`.
- OpenRouter allows browser calls, so static bundles work. It's the easiest way to use
  Claude models from a browser-only site.
- Tool use depends on the model, so pick one that reliably calls tools.

## Anthropic

- Anthropic's OpenAI-compatible endpoint is `https://api.anthropic.com/v1`. It accepts
  your Anthropic key as a Bearer token, and tool calls work.
- Anthropic blocks browser calls unless the request carries a special opt-in header,
  which `nsdeploy` currently doesn't send.
- This endpoint's model list can't be read, so there is no model check. Type an exact
  model ID such as `claude-haiku-4-5`.
- For a static bundle, put OpenRouter or LiteLLM in front of Anthropic.

## LiteLLM, self-hosted

[LiteLLM](https://docs.litellm.ai/) is a proxy you run yourself. Your provider keys stay
on the LiteLLM server, and the browser only holds a LiteLLM key.

1. Install it:
   ```shell
   pip install 'litellm[proxy]'
   ```
1. Write `config.yaml`. Each `model_name` is the alias that site visitors type as Model:
   ```yaml
   model_list:
     - model_name: gpt-4.1-mini
       litellm_params:
         model: openai/gpt-4.1-mini
         api_key: os.environ/OPENAI_API_KEY
     - model_name: claude-haiku-4-5
       litellm_params:
         model: anthropic/claude-haiku-4-5
         api_key: os.environ/ANTHROPIC_API_KEY
   general_settings:
     master_key: os.environ/LITELLM_MASTER_KEY
   ```
1. Set `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in your shell, make a master key, and
   start the proxy:
   ```shell
   export LITELLM_MASTER_KEY="sk-$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
   litellm --config config.yaml --host 127.0.0.1 --port 4000
   ```
1. Point the site at `http://127.0.0.1:4000/v1` as Router base URL.

Things to know:

- **Master key.** The proxy won't start without one. Use it yourself for testing, but
  give anyone else a LiteLLM virtual key, never the master key.
- **CORS.** LiteLLM allows every origin by default, which is why static bundles work. It
  also means any website can use your proxy with a valid key. Set `LITELLM_CORS_ORIGINS`
  to limit it to your site's origin.
- **Model names.** The model list shows your `model_name` aliases, so visitors type the
  alias, such as `gpt-4.1-mini`.
- **For a public site,** run LiteLLM on a server behind HTTPS, and set Router base URL
  to its address, such as `https://litellm.example.com/v1`. Set `LITELLM_CORS_ORIGINS`
  to your site's origin, such as `https://example.com` (a comma-separated list for more
  than one), and give each visitor a virtual key. Browsers block an `https` page from
  calling a plain `http` address other than `localhost`.

## Ollama, local

[Ollama](https://ollama.com) runs open models on your own machine, so no provider key
is needed. It's a quick way to try a site locally.

1. Install Ollama and pull a model that makes tool calls:
   ```shell
   ollama pull gemma4:e4b
   ```
1. Serve the site from `127.0.0.1` or `localhost`, as in the
   [Quickstart](../quickstart.md#manually-generate-a-website-bundle).
1. In the panel, set:
   - API key: any text, such as `ollama`. Ollama ignores it, but the site won't send a
     request with an empty key.
   - Model: `gemma4:e4b`
   - Router base URL: `http://127.0.0.1:11434/v1`

Things to know:

- **CORS.** By default, Ollama allows pages on `localhost` and `127.0.0.1` at any port,
  and refuses other origins with 403. To allow more, set `OLLAMA_ORIGINS` to a
  comma-separated list of origins and restart Ollama. These are added to the defaults.
  The [Ollama FAQ](https://docs.ollama.com/faq) shows how to set it on each OS.
- **Don't use `*`.** Ollama has no keys, so any page allowed by `OLLAMA_ORIGINS` can use
  your models.
- **Model IDs** are Ollama's tags, as `ollama list` shows them. The model check uses
  Ollama's model list, so a model you haven't pulled is refused.
- **Only for your own machine.** `127.0.0.1` is always the visitor's own computer, so a
  site pointed at it works only for people who run Ollama themselves.
- **Local models are slow.** A multi-agent turn can take a minute or more.
- **For a public site,** run Ollama on a server behind a gateway that has keys and
  allows your site's origin, such as a
  [self-hosted Otari](otari.md#self-hosted-otari-with-local-models). Don't expose Ollama
  itself on the internet: it has no keys, so anyone could use it.

## Otari

See [Otari](otari.md) for details.
