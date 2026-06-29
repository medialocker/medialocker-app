#!/usr/bin/env bash
# Bring up the full local stack for testing:
#   MinIO (storage) + Redis (reused if present) + migrate + seed + api/app/web.
# Backend (Postgres + Auth) is your Supabase Cloud project, configured in .env.
#
# Usage:
#   scripts/dev-up.sh            # infra + migrate + seed + build + start services
#   scripts/dev-up.sh --no-seed  # skip the seed step
#   scripts/dev-up.sh --no-build # skip the Next production builds (use existing .next)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$(cd "$ROOT/../medialocker-web" && pwd)"
LOGDIR="$ROOT/.dev-logs"
mkdir -p "$LOGDIR"

DO_SEED=1; DO_BUILD=1
for a in "$@"; do
  case "$a" in
    --no-seed) DO_SEED=0 ;;
    --no-build) DO_BUILD=0 ;;
  esac
done

echo "▸ MinIO (S3 storage) on :9000"
if ! curl -fsS http://localhost:9000/minio/health/live >/dev/null 2>&1; then
  docker rm -f ml-minio >/dev/null 2>&1 || true
  docker run -d --name ml-minio -p 9000:9000 -p 9001:9001 \
    -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
    minio/minio server /data --console-address ":9001" >/dev/null
  until curl -fsS http://localhost:9000/minio/health/live >/dev/null 2>&1; do sleep 1; done
fi

echo "▸ Redis on :6379"
if ! (echo > /dev/tcp/localhost/6379) >/dev/null 2>&1; then
  docker rm -f ml-redis >/dev/null 2>&1 || true
  docker run -d --name ml-redis -p 6379:6379 redis:7-alpine >/dev/null
  sleep 1
fi

echo "▸ Migrate Supabase Cloud DB"
"$ROOT/scripts/with-env.sh" pnpm --filter @medialocker/db migrate >"$LOGDIR/migrate.log" 2>&1 || {
  echo "  migrate failed — see $LOGDIR/migrate.log"; exit 1;
}

if [ "$DO_SEED" = 1 ]; then
  echo "▸ Seed dev data (test@test.com / Test123!)"
  "$ROOT/scripts/with-env.sh" pnpm --filter @medialocker/worker exec tsx scripts/seed-dev.ts | tail -7
fi

if [ "$DO_BUILD" = 1 ]; then
  echo "▸ Build dashboard + website (production)"
  pnpm --filter @medialocker/app build >"$LOGDIR/app-build.log" 2>&1
  (cd "$WEB" && pnpm build >"$LOGDIR/web-build.log" 2>&1)
fi

echo "▸ Start services"
pkill -f "apps/api/dist/index.js" 2>/dev/null || true
"$ROOT/scripts/with-env.sh" node "$ROOT/apps/api/dist/index.js" >"$LOGDIR/api.log" 2>&1 &
( cd "$ROOT/apps/app" && pnpm exec next start -p 3001 >"$LOGDIR/app.log" 2>&1 & )
( cd "$WEB" && pnpm exec next start -p 3000 >"$LOGDIR/web.log" 2>&1 & )

# Wait for health
for p in "3002 api/api/health" "3001 dashboard" "3000 website"; do
  set -- $p; path="${1#*/}"; port="${1%%/*}"
  for _ in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/${path#*/}" 2>/dev/null || echo 000)
    [ "$code" != "000" ] && break; sleep 1
  done
done

cat <<EOF

✓ Stack is up
  Website    http://localhost:3000
  Dashboard  http://localhost:3001   (login: test@test.com / Test123!)
  API        http://localhost:3002
  MinIO      http://localhost:9001   (minioadmin / minioadmin)
  Logs       $LOGDIR
EOF
