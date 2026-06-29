# Command Line (CLI)

`medialocker` is the official command-line client for MediaLocker. It drives the
same REST API documented here — buckets, media, search, tags, categories, sets,
storyboards, usage, billing, and API keys — with the same organization-scoped
credentials, and ships a local MCP server for AI agents.

- **Package:** [`medialocker`](https://www.npmjs.com/package/medialocker) on npm
- **Source:** [github.com/medialocker/medialocker-cli](https://github.com/medialocker/medialocker-cli) (AGPL-3.0)
- **Requires:** Node.js ≥ 22

## Install

```bash
npm install -g medialocker
# or run without installing
npx medialocker --help
```

## Quickstart

```bash
# 1. Point at your MediaLocker (defaults to https://api.medialocker.io)
medialocker config set url https://api.medialocker.io

# 2. Authenticate with an API key secret — verifies against /me and saves it
medialocker login

# 3. Use it
medialocker buckets list
medialocker media upload ./hero.mp4 --bucket marketing --tag launch
medialocker media list --bucket marketing --kind video
```

Uploads and downloads stream **directly to and from object storage** over
presigned URLs — the API never touches your bytes, exactly like the
[presign → PUT → confirm](/developer/presign) flow. The CLI authenticates with an
API key's **Secret Access Key** and honors its [scopes](/developer/authentication#scopes),
so a `read`-only key can list and download but not upload or delete.

::: tip Built for scripting
Add `--json` to any command for clean, pipeable output. Banners, spinners, and
status notes go to stderr, so stdout stays pure JSON:

```bash
medialocker --json media list --bucket marketing | jq -r '.items[].key'
```
:::

## What's here

| Page | Covers |
|---|---|
| [Installation](/developer/cli/installation) | Install, upgrade, and verify the CLI |
| [Configuration & Auth](/developer/cli/configuration) | `login`, profiles, env vars, the config file |
| [Command Reference](/developer/cli/commands) | Every command group, global flags, exit codes |
| [Uploading & Downloading](/developer/cli/uploads) | `media upload`/`download`, multipart, presigned URLs |
| [MCP Server](/developer/cli/mcp) | Run the CLI as a local MCP server for AI agents |

## See also

- [API Reference](/developer/api-reference) — the REST endpoints each command calls
- [Authentication](/developer/authentication) — API keys, scopes, and bucket scope
- [Presigned Uploads](/developer/presign) — the upload/download flow the CLI wraps
