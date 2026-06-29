# Security Policy

We take the security of MediaLocker seriously. Thank you for helping keep the project
and its users safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Provide as much detail as you can (see below).

This opens a private channel with the maintainers.

### What to include

A good report helps us triage quickly. Please include:

- A clear description of the issue and its impact.
- The component affected (`api`, `app`, `mcp`, `worker`, a package, or infra).
- Steps to reproduce, or a proof-of-concept.
- The version, commit, or deployment where you observed it.
- Any suggested remediation, if you have one.

### What to expect

- **Acknowledgement** within a few business days.
- An assessment of severity and scope, and follow-up questions if we need them.
- Coordinated disclosure: we'll work with you on a fix and timing, and credit you in
  the advisory unless you prefer to remain anonymous.

Please give us a reasonable window to address the issue before any public disclosure.

## Scope

Vulnerabilities in the MediaLocker codebase are in scope, including but not limited to:

- **Tenant isolation** — any path that exposes one organization's data, storage, or
  usage to another.
- **Authentication & authorization** — API keys, scopes, session JWTs, internal HMAC,
  and the MCP tool allowlist / destructive-tool firewall.
- **Presigned URLs** — signing logic, expiry handling, or scope of granted access.
- **Billing & capacity** — quota bypass, metering errors, or proration manipulation.
- **Secret handling** — exposure of credentials, encryption keys, or webhook secrets.

Issues in third-party dependencies or managed services (Supabase, Hetzner, Stripe,
Cloudflare) should be reported to those vendors, though we're happy to help coordinate.

## Supported versions

MediaLocker is under active development. Security fixes are applied to the `main`
branch; please ensure you are running a recent version before reporting.
