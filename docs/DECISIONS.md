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
- Why: the same image runs locally (`http://api:3000` over the compose network) and on Render (platform-injected `PORT`, public HTTPS URL of the API) without rebuilding.
- Trade-offs / when to revisit: nginx resolves the upstream host once at startup, so the API must be resolvable first (compose uses `depends_on: service_healthy`); a long-lived container would not notice an IP change of the upstream.

### Static Site on Render instead of nginx: rejected

- Considered: Render Static Site with a rewrite rule for `/api/*`, which would remove nginx and the web Dockerfile.
- Why not: community reports say responses proxied through static-site rewrites are buffered, which would deliver the streamed chat answer in one piece. Not verified by me; revisit with a real measurement if the nginx service becomes a burden.

### Web reaches the API through its public URL on Render

- Chosen: `API_UPSTREAM=https://<api-service>.onrender.com`, entered by hand when the Blueprint is created (`sync: false`).
- Why: free web services cannot receive private-network traffic, and `fromService ... host` only gives the private hostname, so the Blueprint cannot compute the public URL.
- Trade-offs / when to revisit: both services sleep after 15 min idle, so a cold visit can wait for two wake-ups (~1 min each). On a paid plan, switch to the private network (`fromService`) and drop the manual step. nginx must not override `Host`: Render routes public traffic by it.

### Free-tier Render stack

- Chosen: one Blueprint with `rag-chat-db` (free Postgres 17), `rag-chat-api` and `rag-chat-web` (free Docker web services), all in `frankfurt`.
- Why: free web services can only talk to the database over the private network inside one region; pgvector is supported on Render Postgres (`CREATE EXTENSION vector`).
- Trade-offs / when to revisit: free Postgres is deleted 30 days after creation (1 GB, one per workspace); free web services idle out after 15 min. Fine for a demo, not for production.

### Auto-deploy only after CI passes

- Chosen: `autoDeployTrigger: checksPass` on both services.
- Why: a red commit on `main` should not reach the running demo. Render waits for the GitHub Actions checks of the commit.
- Trade-offs / when to revisit: needs at least one check to exist, otherwise Render never deploys.

### Migrations run on API startup

- Chosen: apply Drizzle migrations when the API container starts (wired in Stage 3).
- Why: `preDeployCommand` is not something to rely on for free services; startup migration works on every plan.
- Trade-offs / when to revisit: with several API instances this races; production would run migrations as a separate release step.
