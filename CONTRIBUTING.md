# Contributing to MediaLocker

Thanks for your interest in improving MediaLocker! This document covers how to set up
your environment, the standards we hold changes to, and how to get a pull request
merged.

By participating in this project you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Getting set up

1. **Fork and clone** the repository.
2. Use **Node.js ≥ 22** (`.nvmrc` pins `22`) and **pnpm 9.15**
   (`corepack enable && corepack prepare pnpm@9.15.0 --activate`).
3. Install dependencies:

   ```bash
   pnpm install
   cp .env.example .env   # fill in the values you need for what you're working on
   ```

See the [README](./README.md) for the repository layout and the
[Self-Hosting Guide](./apps/docs/src/self-hosting/index.md) for full backend setup
(Supabase Cloud, Hetzner Object Storage, Stripe).

## Development workflow

This is a pnpm + Turborepo monorepo. Scope commands to a single package with
`--filter`, or run them across the workspace from the root:

```bash
pnpm dev          # all apps in watch mode
pnpm build        # build everything
pnpm lint         # lint
pnpm typecheck    # type-check
pnpm test         # unit tests (per package)
pnpm format       # prettier --write

# scope to one package
pnpm --filter @medialocker/api dev
```

### Before you open a PR

Run the same gates CI enforces — your PR will not merge until they pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If your change touches capacity accounting or billing, also run the integration
suite, which exercises that code against **real Postgres**:

```bash
pnpm test:integration:setup
pnpm test:integration
pnpm test:integration:teardown
```

## Coding standards

- **TypeScript everywhere.** Keep types strict; avoid `any` where a real type fits.
- **Formatting is Prettier.** Run `pnpm format` (or rely on `pnpm lint`'s checks) —
  don't hand-format.
- **Match the surrounding code.** Follow the conventions, naming, and structure of the
  file you're editing rather than introducing a new style.
- **Keep apps thin.** Business logic belongs in `packages/*`; apps wire it together.
- **Multi-tenancy is non-negotiable.** Every org-owned query must be scoped to its
  organization. A missing tenant filter is a cross-tenant data leak — treat it as a
  blocking bug.
- **Validate input** at the boundary (Zod) and never log secrets or credentials.

## Database changes

Schema lives in [`packages/db`](./packages/db) as ordered SQL migrations.

- Scaffold a **new** migration file with the next sequence number:

  ```bash
  pnpm db:generate "add object archive flag"
  # → packages/db/migrations/011_add_object_archive_flag.sql
  ```

- Never edit an already-released migration — the runner checksums applied files
  and will refuse a changed one.
- Prefer backward-compatible changes (nullable/defaulted columns) so existing
  deployments migrate cleanly.
- Migrations hold a session-level advisory lock, so they run against the **session
  pooler (5432) or a direct connection**, not the `6543` runtime pooler:

  ```bash
  DATABASE_URL=<session-or-direct-url> pnpm db:migrate
  ```

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org), matching the
existing history:

```
type(scope): short summary

fix(api/billing): dedup bearer crypto, add idempotency key
feat(worker): regenerate derivatives on object overwrite
docs(self-hosting): clarify session vs transaction pooler
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

## Pull requests

- Branch from `main` and open your PR against `main`.
- Keep PRs focused — one logical change per PR is easier to review.
- Fill out the PR template: what changed, why, how you tested it, and any migration or
  backward-compatibility impact.
- Link the issue your PR addresses (`Closes #123`).
- Expect review feedback; CI (lint, typecheck, test, build, MCP contract, Docker
  build, integration, Trivy scans) must be green before merge.

## Reporting bugs and requesting features

Open an issue using the appropriate template. For **security vulnerabilities**, do
**not** open a public issue — follow [SECURITY.md](./SECURITY.md) instead.

## License

By contributing, you agree that your contributions will be licensed under the
[GNU Affero General Public License v3.0](./LICENSE), the same license as the project.
