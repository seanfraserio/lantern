FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/sdk/ packages/sdk/
COPY packages/proxy/ packages/proxy/
RUN pnpm install --frozen-lockfile --filter @lantern-ai/proxy... --shamefully-hoist
RUN pnpm --filter @lantern-ai/sdk run build
RUN pnpm --filter @lantern-ai/proxy run build

FROM node:20-alpine
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/sdk ./packages/sdk
COPY --from=base /app/packages/proxy ./packages/proxy
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "packages/proxy/dist/cli.js"]
