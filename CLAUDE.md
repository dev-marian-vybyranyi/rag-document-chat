# CLAUDE.md

Guidance for AI coding assistants working in this repository.

## Project

RAG chat over the user's own sources: English documents (PDF, TXT, MD) and code repositories (a public
GitHub address or a zip archive). Answers are grounded in the sources and cite them: a document by name
and page, a repository file by `path:lines`. A repository is a row of the same `documents` table
(`kind = repository`) whose chunks carry `path`, `language`, `start_line`, `end_line` and `symbol`.

Two services in an npm-workspaces monorepo:

- `apps/api` – Express + TypeScript, Vercel AI SDK (Gemini or OpenAI, chosen by `AI_PROVIDER`), Drizzle ORM,
  Postgres + pgvector
- `apps/web` – React + Vite + TypeScript + Tailwind + shadcn/ui + React Router

Deployed to Render via a Blueprint (`render.yaml`) using Docker. CI runs on GitHub Actions.
Everything must work on free tiers. Development and tests run on Gemini; a deployment may use OpenAI.

Where things are (`apps/api/src`): `documents` (upload, extraction, chunking, ingestion queue),
`repositories` (import from GitHub or zip, file filter and secret guard, code chunker, overview,
ingestion, suggestions), `rag` (retrieval, fusion, relevance, prompts, sanitising), `chat`, `ai` (provider
interface and the Google and OpenAI implementations, quota classification), `eval` (retrieval and
faithfulness evaluation, code corpus). `docs/DECISIONS.md` records why each non-obvious choice was made.

## Commands

Run from the repository root:

```bash
npm install          # install all workspaces
cp .env.example .env # once; then start Postgres with pgvector:
docker compose up -d db
npm run dev          # api (:3000) and web (:5173) together; web proxies /api/* to the api
npm run lint         # eslint
npm run format       # prettier --write
npm run typecheck    # tsc --noEmit in every workspace
npm test             # vitest in every workspace (api integration tests need the db container)
npm run test:unit -w @rag-chat/api   # api unit tests only, no database needed
npm run db:generate -w @rag-chat/api # new SQL migration after editing src/db/schema.ts (rename the file to say what it does)
docker compose up --build   # full stack in containers on http://localhost:8080
```

Evaluations call real models and use free quota, so they are run by hand and never from tests:

```bash
npm run eval:retrieval -w @rag-chat/api     # documents: hit@k, MRR, relevance threshold sweep
npm run eval:faithfulness -w @rag-chat/api  # documents: grounded answers graded by a second model
npm run eval:code -w @rag-chat/api          # code: downloads the pinned reference repository, same metrics
```

## Conventions

- TypeScript strict mode everywhere; no `any` without a comment explaining why.
- ESM only. Use `import type` for type-only imports.
- Validate every external input (HTTP bodies, env vars, LLM output) with zod.
- Keep modules small and feature-oriented (`auth`, `documents`, `repositories`, `rag`, `chat`), not
  layer-oriented.
- Everything from an imported repository (paths, symbols, comments, README text) is untrusted: escape it in
  prompts and attributes, never build a URL, a query or a suggested question from it unvalidated, and never
  index a secret (the filter and the content check in `repositories/filter.ts` are the guard).
- UI components come from shadcn/ui (`npx shadcn@latest add <name>` inside `apps/web`); the CLI is not a
  dependency. Use the `@/` import alias for files under `apps/web/src`.
- No RAG framework (LangChain, LlamaIndex). The Vercel AI SDK is used only for model calls,
  embeddings and streaming; retrieval and prompting are written explicitly.
- Never hardcode secrets. Configuration comes from environment variables; document new ones in
  `.env.example`.
- No comments in TypeScript: clear names carry the _what_, and the _why_ goes to `docs/DECISIONS.md`.
- Write tests alongside behaviour changes. Mock the LLM and embeddings in tests; never call real
  APIs from the test suite.
- Record non-obvious design decisions in `docs/DECISIONS.md`: what was chosen, why, what it costs and when
  to revisit. Put measured numbers there, and only numbers that were really measured.
- Do not add third-party source code or documents to the repository to evaluate against; fetch them at a
  pinned commit at run time and record the source and licence in `samples/SOURCES.md`.

## Working agreement

- **Do not run `git commit`, `git push` or any history-rewriting command.** The maintainer commits
  manually after verifying the change.
- Work in small, reviewable steps; each step should leave lint, typecheck and tests green.
- Commit messages follow Conventional Commits (`feat(api): ...`, `fix(web): ...`, `docs: ...`).
- Check current library documentation before using an API from memory (AI SDK, Drizzle, Gemini
  model names and limits change often).
- Mutation-check new tests: break the code, confirm the right test fails, restore it.
- Integration tests need the database container (`docker compose up -d db`); start Docker first if they
  fail with `ECONNREFUSED`.
- Do not add dependencies, abstractions or features beyond what the task needs.
