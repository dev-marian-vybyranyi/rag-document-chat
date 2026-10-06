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
