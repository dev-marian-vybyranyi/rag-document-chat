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

### Password hashing with Node's built-in scrypt

- Chosen: `crypto.scrypt` (N=2^15, r=8, p=3, 16-byte salt), stored as `scrypt$N$r$p$salt$hash`.
- Considered: argon2 (`argon2` package), bcrypt.
- Why: scrypt is on OWASP's list and ships with Node, so there is no native module to compile in the Alpine image. The cost parameters live inside each hash, so they can be raised later without invalidating old passwords.
- Trade-offs / when to revisit: argon2id is the first OWASP choice and could replace it; ~32 MiB per hash is acceptable on the 512 MB free instance only because logins are rate limited (added later).

### Login does not reveal whether an email exists

- Chosen: unknown email and wrong password give the same 401 body, and an unknown email is still verified against a decoy hash so the response time matches.
- Trade-offs / when to revisit: registration still answers 409 for a taken email (needed for a usable sign-up form), so enumeration is possible there. Closing it needs email verification, which is out of scope.

### Uniform JSON error contract

- Chosen: every error is `{ error: { code, message, details? } }`; `AppError` carries the status and a stable machine-readable code, unexpected errors become a generic 500 and are only logged.
- Why: the frontend can branch on `code`, and internal messages never leak.

### Sessions: opaque token in an httpOnly cookie, hash stored in Postgres

- Chosen: 32 random bytes in a `sid` cookie (httpOnly, SameSite=Lax, Secure in production); the `sessions` table holds only the SHA-256 of the token; fixed 7-day lifetime; expired rows are purged whenever a new session is created.
- Considered: JWT in a cookie or `localStorage`.
- Why: a server-side row can be revoked on logout; a leaked table is not replayable; page scripts never see the token. SameSite=Lax is the CSRF defence, since the API only accepts JSON and cross-site POSTs do not carry the cookie.
- Trade-offs / when to revisit: one extra query per authenticated request; no sliding expiry or "sign out everywhere"; `Secure` is controlled by `COOKIE_SECURE` because the plain-HTTP compose setup cannot use it (Safari rejects Secure cookies on http://localhost).

### Rate limits keyed by account, not by client IP

- Chosen: 10 failed sign-ins per email per 15 min (successful ones are not counted and a correct password clears the counter) plus a ceiling of 100 requests/min across all `/auth` routes.
- Considered: the usual per-IP limit with `trust proxy`.
- Why: in front of the API sit Render's edge, our nginx and Render's edge again, so the real client IP is at an unpredictable position in `X-Forwarded-For`. A wrong `trust proxy` hop count either gives every user the same key (one attacker locks out the whole site) or lets attackers choose their own key.
- Trade-offs / when to revisit: someone who knows an email can lock that account for 15 minutes; counters live in memory, so they reset on restart and are per instance. With a known proxy topology add a per-IP limit, and move the store to Redis when running several instances.

### Frontend auth state: plain React context, with an `unavailable` state

- Chosen: `AuthProvider` asks `/auth/me` on start and exposes `loading | anonymous | unavailable | authenticated`; the HTTP layer is a thin `fetch` wrapper that turns the API error contract into `ApiError`.
- Considered: TanStack Query, axios.
- Why: auth state is one small value, so a library would be overhead for now. `unavailable` is separate from `anonymous` on purpose: a free-tier API that is still waking up answers 502, and showing the login form then would look like the user had been signed out.
- Trade-offs / when to revisit: server data for chats and documents (polling, caching, optimistic updates) is where a data-fetching library starts to pay off; revisit at that point.

### UI kit: shadcn/ui (Radix, "Nova" preset) with Tailwind 4, CLI not kept as a dependency

- Chosen: shadcn components copied into `apps/web/src/components/ui` (button, input, label, card, alert); added with `npx shadcn@latest add <name>` when needed.
- Why: accessible primitives I own and can edit, no runtime component library to upgrade. The CLI package itself pulled in 7 high-severity advisories (`braces`/`fast-glob`/`ts-morph`) and the app only needed one CSS file from it, so the few `@custom-variant` rules were inlined into `index.css` and the CLI is invoked through `npx` only.
- Trade-offs / when to revisit: generated files follow shadcn's style, not ours (formatted with Prettier, `react-refresh` lint rule off for that folder). The generated `utils.ts` re-exports `cn` from the shadcn-maintained `cn` package (checked: published by the shadcn author, repo `shadcn-ui/cn`).

### Routing: React Router in declarative mode, guards as layout routes

- Chosen: `RequireAuth` and `RedirectIfAuthenticated` are layout routes wrapping the pages; they render loading and "server not responding" screens themselves, so no page has to handle those states.
- Why: one place decides who may see what; after signing in the user lands where they were headed (`from` location state).
- Trade-offs / when to revisit: the guard only controls the UI. The API enforces access itself with `requireAuth`, so a tampered client gains nothing.

### Auth forms rely on the server for validation

- Chosen: native constraints (`required`, `type=email`, `minLength`) for instant feedback; the API's field errors are shown next to the inputs and anything else in an alert.
- Why: one source of truth for the rules; no schema duplicated in the browser.
- Trade-offs / when to revisit: native validation bubbles are browser-styled; switch to a form library with a shared schema if forms become more complex.

### Document store: `documents` and `chunks` in the same Postgres

- Chosen: `chunks` holds the text, a `vector(768)` embedding and a generated English `tsvector`, with an HNSW index (`vector_cosine_ops`) and a GIN index; `user_id` is copied onto every chunk; ingestion state lives in a `document_status` enum (`processing | ready | failed`).
- Why: one database for vectors, keywords and metadata means hybrid retrieval is a single SQL query and a user's data is removed by cascading deletes. `user_id` on the chunk lets every retrieval query filter by owner without joining `documents`. 768 dimensions is a supported size for both current Gemini embedding models and keeps each row around 3 KB, which matters on the 1 GB free database. The keyword side is hardcoded to English because documents are English-only by design.
- Trade-offs / when to revisit: changing the embedding dimension or language means a migration plus re-embedding everything. HNSW applies the owner filter after the index scan, so queries must over-fetch (pgvector's iterative scans) or users with few chunks could get too few results; handled in the retrieval step.

### Uploads: validated in memory, original file not kept

- Chosen: multer with memory storage, one file in the `file` field, 10 MB limit, no extra form fields; type decided by extension and then confirmed by content (PDF header, valid UTF-8 without NUL bytes for text/Markdown); the display name is stripped of directories and control/direction-override characters; the endpoint answers `202` with the document in `processing`.
- Why: only extracted text is needed afterwards, so there is no file storage to run or secure; extension-plus-content avoids trusting the browser's MIME type, which differs by platform for Markdown; `202` keeps the request short while indexing runs.
- Trade-offs / when to revisit: the source viewer can show extracted text but not the original PDF. In production the original would go to object storage (S3/GCS) and ingestion into a queue.

### nginx body limit above the API's own limit

- Chosen: `client_max_body_size 12m` on `/api/`, API limit 10 MB.
- Why: nginx's default of 1 MB silently rejects uploads the API would accept (caught while testing through docker compose with a 5 MB file). Staying slightly above the API limit means a 10.6 MB file gets the API's JSON error instead of an HTML page.
- Trade-offs / when to revisit: anything over 12 MB still gets nginx's HTML 413, which the frontend must treat as "file too large".

### Text extraction: `unpdf` for PDFs, no OCR

- Chosen: `unpdf` (a serverless build of PDF.js) reading page by page; plain text and Markdown are read as UTF-8. PDF lines are joined into running text and words hyphenated across lines are rejoined; a PDF with no selectable text, a damaged one, a password-protected one or one over 500 pages is rejected with a reason the user can read.
- Considered: `pdf-parse`, `pdfjs-dist` directly.
- Why: it runs in plain Node and in the Alpine image without native modules (checked in the built container), keeps page numbers (needed for citations) and is actively maintained. PDF.js delivers text hard-wrapped at every visual line with paragraph breaks lost, which is why soft line breaks are turned into spaces before chunking.
- Trade-offs / when to revisit: scanned PDFs need OCR, which is out of scope. Layout is flattened, so tables and multi-column pages read in PDF order and may interleave. The page limit protects the 512 MB instance.

### Chunking: paragraphs, then sentences, then words; about 400 tokens with 60 overlap

- Chosen: units are paragraphs; a paragraph larger than a chunk is cut at sentence ends and a sentence larger than a chunk between words (inside a word only if it has no spaces). Units are packed up to 400 tokens; the last sentences (up to 60 tokens) of a chunk are repeated at the start of the next. Markdown chunks that do not begin with their section title get it prepended, so a chunk deep inside "## Installation" still says where it is from.
- Why: ~400 tokens is small enough that one chunk is about one idea (precision) and big enough to hold a full answer; 15 % overlap protects statements that straddle a boundary; never cutting inside a sentence keeps every chunk readable, which matters because chunk text is both embedded and shown as the citation.
- Page breaks: overlap is also carried across them, and a chunk takes the page number where its own text starts. Found by running a real multi-page PDF: with chunks forbidden to cross pages, a sentence cut by the page break ended up whole in no chunk at all. A chunk may now open with a few sentences from the previous page, which makes the page citation slightly generous for those sentences.
- Token counts are estimated as characters / 4. There is no Gemini tokenizer for Node, and for English the estimate is close enough to size chunks; the embedding model's input limit (2,048 tokens for `gemini-embedding-001`) leaves a wide margin.
- Trade-offs / when to revisit: whole paragraphs bigger than the overlap are not repeated (only sentence-level tails are); no semantic chunking (embedding-based boundary detection), which costs an embedding call per sentence; tables and code are not treated specially.
