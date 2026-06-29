# MCP Authentication

The MCP server uses the **same API keys** as the REST API. Authenticate by sending
an API key's **Secret Access Key** as a bearer token on the connection:

```
Authorization: Bearer <secret-access-key>
```

The gateway resolves the token to an organization and a scope set exactly as the
REST API does — see [Authentication](/developer/authentication) for how keys, the
`ml_…` access key ID, secrets, scopes, and bucket scope work.

## Scopes

Each tool requires a scope; the `admin` scope implies all others. The token's
scopes determine which tools you can call:

| Scope | Example tools |
|---|---|
| `read` | `search_media`, `list_objects`, `get_object_url`, `get_usage` |
| `write` | `upload_object`, `manage_tags`, `create_set`, `generate_variants` |
| `delete` | `delete_object`, `delete_bucket`, `purge` |
| `admin` | `create_api_key` |

A call that exceeds your scopes is rejected before the tool runs.

## Tool allowlisting

Beyond scopes, a credential can carry a **per-credential allowlist** — an explicit
set of tool names it may invoke. The gateway enforces this on every request, so a
key can be narrowed to, say, only `search_media` and `get_object_url` even if its
scopes would otherwise permit more. Tools outside the allowlist are blocked and
don't appear in `tools/list`.

## Destructive-tool firewall

The destructive tools — `delete_object`, `delete_bucket`, and `purge` — pass
through an additional **tool-use firewall** on top of scopes and the allowlist. The
firewall applies policy checks, validates arguments, and audits the call before the
handler runs. Some destructive tools also require an explicit confirmation argument
(for example, `purge` requires `confirm: "DELETE"`).

::: warning Treat MCP keys like production credentials
An MCP key can read and mutate real media. Grant the **minimum** scopes needed,
prefer a **bucket-scoped** key when an agent only needs one bucket, and use the
allowlist to restrict the exact tools an agent can call.
:::
