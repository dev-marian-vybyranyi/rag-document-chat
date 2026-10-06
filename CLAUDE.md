# CLAUDE.md

Guidance for AI coding assistants working in this repository.

## Project

RAG document chat: users upload English documents (PDF, TXT, MD) and ask questions about them.
Answers are grounded in the documents and cite their sources.

Two services in an npm-workspaces monorepo:

- `apps/api` – Express + TypeScript, Vercel AI SDK (Gemini), Drizzle ORM, Postgres + pgvector
- `apps/web` – React + Vite + TypeScript + Tailwind

Deployed to Render via a Blueprint (`render.yaml`) using Docker. CI runs on GitHub Actions.
Everything must work on free tiers.

## Commands

Run from the repository root:

```bash
npm install          # install all workspaces
npm run lint         # eslint
npm run format       # prettier --write
npm run typecheck    # tsc --noEmit in every workspace
npm test             # vitest in every workspace
```

## Conventions

- TypeScript strict mode everywhere; no `any` without a comment explaining why.
- ESM only. Use `import type` for type-only imports.
- Validate every external input (HTTP bodies, env vars, LLM output) with zod.
- Keep modules small and feature-oriented (`auth`, `documents`, `rag`, `chat`), not layer-oriented.
- No RAG framework (LangChain, LlamaIndex). The Vercel AI SDK is used only for model calls,
  embeddings and streaming; retrieval and prompting are written explicitly.
- Never hardcode secrets. Configuration comes from environment variables; document new ones in
  `.env.example`.
- Comments explain _why_, not _what_. Prefer clear names over comments.
- Write tests alongside behaviour changes. Mock the LLM and embeddings in tests; never call real
  APIs from the test suite.
- Record non-obvious design decisions in `docs/DECISIONS.md` (one or two sentences each).

## Working agreement

- **Do not run `git commit`, `git push` or any history-rewriting command.** The maintainer commits
  manually after verifying the change.
- Work in small, reviewable steps; each step should leave lint, typecheck and tests green.
- Commit messages follow Conventional Commits (`feat(api): ...`, `fix(web): ...`, `docs: ...`).
- Check current library documentation before using an API from memory (AI SDK, Drizzle, Gemini
  model names and limits change often).
- Do not write or rewrite `README.md` prose: it must reflect the maintainer's own reasoning.
- Do not add dependencies, abstractions or features beyond what the task needs.
