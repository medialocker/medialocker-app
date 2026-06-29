FROM node:22-alpine@sha256:ab07539e0988b63558ff621f5fbe1077054c39d9809112974fb79993949d41cd AS base
RUN npm install -g pnpm@9.15.0
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @medialocker/app... build

FROM base AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=build /app/apps/app/.next/standalone ./
COPY --from=build /app/apps/app/.next/static ./apps/app/.next/static
COPY --from=build /app/apps/app/public ./apps/app/public
USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["node", "apps/app/server.js"]
