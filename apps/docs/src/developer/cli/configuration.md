# Configuration & Auth

The CLI authenticates with an API key's **Secret Access Key**, sent as a bearer
token — the same credential the [REST API](/developer/authentication) uses. Create
a key in the dashboard under **API Keys**, or with `medialocker apikeys create`.

## Log in

```bash
medialocker login
```

`login` prompts for the API base URL and the secret, verifies them against
`GET /api/me`, and saves them to your config. Run it non-interactively by passing
the secret directly:

```bash
medialocker login --api-key <secret-access-key> --url https://api.medialocker.io
```

Check who you are, or sign out:

```bash
medialocker whoami     # organization, scopes, and active endpoint
medialocker logout     # clears the stored key for the active profile
```

::: warning Send the secret, not the access key ID
The `ml_…` Access Key ID is only an identifier. The value the CLI stores and sends
after `Bearer ` is the **Secret Access Key** — the 64-character hex secret shown
once at creation. Authentication fails if you supply the `ml_…` value.
:::

## Where settings come from

Each setting resolves with this precedence — the first match wins:

| Order | Source | Example |
|---|---|---|
| 1 | Command-line flag | `--url`, `--api-key` |
| 2 | Environment variable | `MEDIALOCKER_API_URL`, `MEDIALOCKER_API_KEY` |
| 3 | Active profile | `~/.config/medialocker/config.json` |
| 4 | Built-in default | `https://api.medialocker.io` |

Flags and environment variables work in any position, so both of these are valid:

```bash
medialocker --api-key <secret> media list
MEDIALOCKER_API_KEY=<secret> medialocker media list
```

## `config` commands

```bash
medialocker config set url https://api.medialocker.io
medialocker config set api-key <secret-access-key>
medialocker config get url
medialocker config list      # effective values and where each comes from
```

`config set default-profile <name>` changes which profile is active by default.

## The config file

Settings live in `~/.config/medialocker/config.json` (honoring `XDG_CONFIG_HOME`).
Because it holds credentials, the CLI writes it with `0600` permissions — readable
and writable only by you.

## Profiles

Profiles let one machine talk to several MediaLockers — say, production and a
self-hosted or local instance. Select one per command with `--profile`:

```bash
# Save credentials under a "local" profile pointed at a dev instance
medialocker --profile local login --url http://localhost:3002

# Use it
medialocker --profile local buckets list
```

## Next steps

- [Command Reference](/developer/cli/commands) — every command and global flag
- [Authentication](/developer/authentication) — the full key, scope, and bucket-scope model
