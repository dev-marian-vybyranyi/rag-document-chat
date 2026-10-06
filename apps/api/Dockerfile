# Build context is the repository root (npm workspaces share one lockfile):
#   docker build -f apps/api/Dockerfile .

FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
# Only the api workspace is installed; the web manifest is not needed for it.
RUN npm ci -w @rag-chat/api --include-workspace-root
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN npm run build -w @rag-chat/api

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w @rag-chat/api --omit=dev && npm cache clean --force
COPY --from=build /repo/apps/api/dist apps/api/dist
# SQL migrations are applied by the server on startup.
COPY apps/api/drizzle apps/api/drizzle

USER node
WORKDIR /repo/apps/api
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
