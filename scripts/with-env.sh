#!/usr/bin/env bash
# Load the local .env into the environment and run a command with it.
# Also ensures DATABASE_URL carries sslmode=require (Supabase requires TLS) without
# editing the .env file. Usage: scripts/with-env.sh <command> [args...]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

case "${DATABASE_URL:-}" in
  *sslmode=*) ;;
  *\?*) DATABASE_URL="${DATABASE_URL}&sslmode=require" ;;
  *)    DATABASE_URL="${DATABASE_URL}?sslmode=require" ;;
esac
export DATABASE_URL

exec "$@"
