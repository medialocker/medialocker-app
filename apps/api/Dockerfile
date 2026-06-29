# Workspace-aware multi-stage build for the control-plane API.
# Build the package + its workspace deps, then `pnpm deploy` a pruned,
# production-only standalone for a small runtime image.
FROM node:22-alpine@sha256:ab07539e0988b63558ff621f5fbe1077054c39d9809112974fb79993949d41cd AS base
RUN npm install -g pnpm@9.15.0
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @medialocker/api... build
RUN pnpm --filter=@medialocker/api deploy --prod /prod/api

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nodejs
COPY --from=build --chown=nodejs:nodejs /prod/api ./
USER nodejs
EXPOSE 3002
ENV PORT=3002
CMD ["node", "dist/index.js"]
