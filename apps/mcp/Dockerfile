# Workspace-aware multi-stage build for the MCP server.
FROM node:22-alpine@sha256:ab07539e0988b63558ff621f5fbe1077054c39d9809112974fb79993949d41cd AS base
RUN npm install -g pnpm@9.15.0
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @medialocker/mcp... build
RUN pnpm --filter=@medialocker/mcp deploy --prod /prod/mcp

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nodejs
COPY --from=build --chown=nodejs:nodejs /prod/mcp ./
USER nodejs
EXPOSE 3003
CMD ["node", "dist/index.js"]
