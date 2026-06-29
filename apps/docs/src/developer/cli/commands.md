# Command Reference

Every command maps to one or more [REST API](/developer/api-reference) endpoints.
Run `medialocker <group> --help` for the full, authoritative option list of any
group. Uploads and the MCP server have their own pages —
[Uploading & Downloading](/developer/cli/uploads) and [MCP Server](/developer/cli/mcp).

## Global flags

These work in any position (`medialocker media list --json` or
`medialocker --json media list`):

| Flag | Effect |
|---|---|
| `--json` | Machine-readable JSON on stdout; logs/spinners go to stderr |
| `--profile <name>` | Use a specific config [profile](/developer/cli/configuration#profiles) |
| `--url <url>` | Override the API base URL |
| `--api-key <key>` | Override the API key secret |
| `--no-color` | Disable colored output |
| `--verbose` | Extra diagnostics on stderr |

## Exit codes

Failures map to script-friendly exit codes:

| Code | Meaning |
|---|---|
| `0` | Success |
| `2` | Usage error (bad flags/arguments) |
| `3` | Authentication error |
| `4` | Network error |
| `5` | Not found |
| `1` | Generic error |

## Authentication

```bash
medialocker login        # store an API key (interactive or --api-key)
medialocker whoami       # show the principal behind the current key
medialocker logout       # clear the active profile's key
```

See [Configuration & Auth](/developer/cli/configuration).

## Buckets

| Command | Does |
|---|---|
| `buckets list` | List buckets in the organization |
| `buckets create <name>` | Create a bucket |
| `buckets info <id>` | Show a bucket and its usage |
| `buckets rm <id>` | Delete an empty bucket (`--yes` to skip confirm) |

## Media

| Command | Does |
|---|---|
| `media list` | List objects (`--bucket --kind --search --tag --category --sort --order --limit --offset`) |
| `media upload <file...>` | Upload files to a bucket — see [Uploading](/developer/cli/uploads) |
| `media download <id>` | Download an object to a file |
| `media info <id>` | Show full object metadata |
| `media rm <id>` | Delete an object (`--yes`) |
| `media metadata <id> --set k=v` | Set object metadata key/values |
| `media url <id>` | Print a presigned download URL |
| `media thumbnail <id>` | Print a presigned thumbnail/poster URL |

## Search

```bash
medialocker search "drone shot" --kind video --tag launch --limit 20
```

Full-text and facet search across media — accepts the same filters as `media list`.

## Tags

| Command | Does |
|---|---|
| `tags list` | List tags |
| `tags create <name>` | Create a tag |
| `tags rm <id>` | Delete a tag (`--yes`) |
| `tags set <objectId> --tags <ids>` | Replace an object's tags (by tag id) |

## Categories

| Command | Does |
|---|---|
| `categories list` | List categories as a tree |
| `categories create <name> [--parent <id>]` | Create a (nested) category |
| `categories rm <id>` | Delete a category (`--yes`) |
| `categories set <objectId> --categories <ids>` | Replace an object's categories |

## Sets

| Command | Does |
|---|---|
| `sets list` | List sets |
| `sets create <name> [--base <objectId>]` | Create a set |
| `sets info <id>` | Show a set and its items |
| `sets add-item <id> --object <objectId>` | Add an object to a set |
| `sets rm-item <id> <itemId>` | Remove an item |
| `sets generate <id>` | Generate derivative variants |
| `sets rm <id>` | Delete a set (`--yes`) |

## Storyboards

| Command | Does |
|---|---|
| `storyboards list` | List storyboards |
| `storyboards create <name>` | Create a storyboard |
| `storyboards info <id>` | Show a storyboard and its clips |
| `storyboards add-clip <id> --object <objectId>` | Append a clip |
| `storyboards reorder <id> --clips <ids>` | Reorder clips |
| `storyboards update-clip <id> <clipId>` | Update a clip's position/note |
| `storyboards rm-clip <id> <clipId>` | Remove a clip |
| `storyboards rm <id>` | Delete a storyboard (`--yes`) |

## Usage

| Command | Does |
|---|---|
| `usage show` | Current storage/request usage snapshot |
| `usage history --days <n>` | Usage over time |
| `usage events` | Recent usage events |

## Billing

| Command | Does |
|---|---|
| `billing subscription` | Show the current subscription |
| `billing portal` | Get a Stripe billing-portal URL |
| `billing invoices` | List recent invoices |
| `billing plans` | List available plans (public) |

## API keys

| Command | Does |
|---|---|
| `apikeys list` | List API keys (secrets are never shown) |
| `apikeys create <name>` | Create a key (`--scopes --bucket --expires-in`) — the secret is shown once |
| `apikeys revoke <id>` | Revoke a key (`--yes`) |
| `apikeys rotate <id>` | Rotate a key's secret (shown once) |

## MCP

```bash
medialocker mcp serve      # run as a local stdio MCP server
medialocker mcp install    # print/merge a client config block
```

See [MCP Server](/developer/cli/mcp).

## Scripting with `--json`

```bash
# Total bytes across a bucket
medialocker --json media list --bucket marketing --limit 1000 \
  | jq '[.items[].size | tonumber] | add'

# IDs of every video
medialocker --json search "" --kind video | jq -r '.items[].id'
```
