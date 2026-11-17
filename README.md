# @local/dsh-opencode-go-usage

Composer-dock meter for an `opencode-go` route: subscription allowance windows
(5-hour / weekly / monthly) and the USD cost of the current Session, beside the
shipped token pills.

## Install

Requires a **web** profile whose `llm-pi-ai` route already talks to OpenCode Go,
plus a credential named `OPENCODE_GO_API_KEY` resolved by the credential seam
(the same one the route uses). Without the credential the cost pill still works
and the allowance pill reports an error.

1. Copy this directory somewhere stable, or clone it:
   `git clone https://github.com/andreramosnl/dsh-opencode-go-usage`
2. In DeepSeek Harness open **Plugins → Add plugin** and pick that directory.
   The Plugin Manager installs it and registers the bundle line itself.
3. Reload the page (F5).

Installing by directory links the checkout, so do not move or delete it
afterwards. To distribute a managed copy instead, publish/tag it and install by
spec (`github:andreramosnl/dsh-opencode-go-usage`).

Override `prices` or `monthlyLimits` in the `opencode-go-usage` bundle line's
`config` (in the profile's `cordis.patch.yml`) if your plan differs from the
published Go rates.

## How it works

- **Host** (`index.js`) resolves `OPENCODE_GO_API_KEY` through the credential
  seam, polls OpenCode's usage endpoint (30 s cache), and folds the durable
  Session log into per-model billed tokens with published Go prices (peak and
  off-peak for DeepSeek). The browser reads both through
  `GET /opencode-go-usage/api/report?sessionId=…`. The route deliberately avoids
  the `/plugin/` namespace, which the client-artifact route owns; sharing it made
  the route vanish whenever the client route registered first on a cold start.
- **Client** (`client.js`) registers one `conversation.composer.dock` entry
  (`order: 2`) rendering two pills: allowance windows and session cost. It
  re-reads once per committed usage change and on a 60 s backstop; clicking the
  allowance pill forces a refresh.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `apiKeyRef` | `OPENCODE_GO_API_KEY` | Credential reference for the usage endpoint |
| `baseUrl` | `https://opencode.ai` | Usage API origin |
| `usagePaths` | `/zen/go/v1/usage`, `/inference/go/v1/usage` | Endpoints tried in order |
| `quotaTtlSeconds` | `30` | Quota cache lifetime |
| `requestTimeoutMs` | `10000` | Per-request timeout |
| `prices` | published Go rates | USD per 1M tokens; optional `peak` block |
| `monthlyLimits` | published Go limits | Monthly USD limit per model |

## Limitations

- The usage API reports percentages only; dollar figures for windows are
  derived from the configured monthly limit and the official window shares.
- Session cost is an estimate from logged tokens and does not price models that
  have no configured rate (they are listed in the tooltip). Retried attempts
  are billed, matching the provider.
