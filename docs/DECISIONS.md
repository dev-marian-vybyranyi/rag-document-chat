# Decisions log

Short working notes on technical decisions and the reasoning behind them.
Raw material for the README – not a polished document.

## Format

```
### <Decision>
- Chosen: …
- Considered: …
- Why: …
- Trade-offs / when to revisit: …
```

## Decisions

### Monorepo with npm workspaces

- Chosen: `apps/api` and `apps/web` in one repository, npm workspaces.
- Considered: pnpm / Turborepo, two separate repositories.
- Why: one clone, one CI pipeline, shared tooling config; npm needs no extra setup in Docker.
- Trade-offs / when to revisit: no shared package yet; add `packages/*` if types need sharing.

### API routes live at the root, nginx adds the `/api` prefix

- Chosen: the Express app serves `/health`, `/auth/...` etc. without a prefix; nginx (and the Vite dev proxy) maps `/api/*` to it and strips the prefix.
- Why: platform health checks hit the API directly at `/health`, independent of the proxy; one rule in one place instead of a prefix baked into every route.
- Trade-offs / when to revisit: API docs and curl examples need to mention both URLs.

### Build context is the repository root for both Dockerfiles

- Chosen: `docker build -f apps/<svc>/Dockerfile .`, `npm ci -w <workspace>` per image.
- Why: workspaces share one `package-lock.json`; each image installs only its own workspace, which also catches missing dependencies that local hoisting hides (found one: `@types/node` in web).
- Trade-offs / when to revisit: any change to the root lockfile invalidates the install layer of both images.

### nginx config rendered from a template at container start

- Chosen: `nginx.conf.template` + the official image's `envsubst` support (`PORT`, `API_UPSTREAM`).
- Why: the same image runs locally (`api:3000` over the compose network) and on Render (platform-injected `PORT`, internal API host) without rebuilding.
- Trade-offs / when to revisit: nginx resolves the upstream host at startup, so the API must be resolvable first (compose uses `depends_on: service_healthy`).
