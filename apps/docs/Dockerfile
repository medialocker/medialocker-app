FROM node:22-alpine@sha256:ab07539e0988b63558ff621f5fbe1077054c39d9809112974fb79993949d41cd AS base
RUN npm install -g pnpm@9.15.0
WORKDIR /app

FROM base AS build
# git is required by VitePress to resolve each page's `lastUpdated` timestamp;
# without it the build dies with "spawn git ENOENT".
RUN apk add --no-cache git
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @medialocker/docs... build

FROM base AS runner
RUN npm install -g serve@14
COPY --from=build /app/apps/docs/src/.vitepress/dist ./dist
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nodejs
USER nodejs
EXPOSE 5173
CMD ["serve", "dist", "-l", "5173"]
