# Build context is the repository root (npm workspaces share one lockfile):
#   docker build -f apps/web/Dockerfile .

FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w @rag-chat/web --include-workspace-root
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN npm run build -w @rag-chat/web

FROM nginxinc/nginx-unprivileged:alpine AS runtime
# PORT: where nginx listens (Render injects its own). API_UPSTREAM: where /api/* is proxied.
ENV PORT=8080 \
    API_UPSTREAM=http://api:3000
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
