# Proposal: Testing Strategy — Mock Phase-Out and Database Environment Tiers

**Status**: Accepted (updated 2026-08-21 for the Postgres migration)
**Date**: 2026-08-20
**Source**: `portfoliost/docs/proposals/testing-strategy.md` (canonical copy)

> This is a cross-reference. The full proposal lives in the frontend repo at
> `portfoliost/docs/proposals/testing-strategy.md`.

## Summary

The project is migrating from mock backend to real backend endpoint by endpoint.
This proposal defines:

1. **Three-tier testing** — backend unit tests (embedded Postgres via PGlite), frontend unit tests (mocked API), E2E tests (real backend + seeded volatile Postgres in docker compose)
2. **Database environment tiers** — volatile + seeded in docker compose (`postgres:17-alpine`, tmpfs), persistent in the cluster (existing cluster Postgres instance), fresh per-test with real migrations for unit tests
3. **Seed system** — `seed/` directory with idempotent Postgres SQL files, run on container start if DB is empty
4. **Mock phase-out process** — per-endpoint migration flow, KrakenD route switching, eventual mock removal

## Key Files

- `src/db/index.ts` — `DATABASE_URL` env var (postgres-js client)
- `src/db/test-db.ts` — PGlite test helper applying migrations from `drizzle/`
- `seed/run.mjs` + `src/db/seed.ts` — seed runner with empty-DB check
- `seed/*.sql` — idempotent seed fixtures (`ON CONFLICT DO NOTHING`)
- `Dockerfile` — CMD includes `db:migrate && db:seed`
- `docker-compose.yml` (in frontend repo) — `postgres` service (volatile), backend `DATABASE_URL`

## Relevance to This Repo

This backend repo is directly affected by:
- Unit tests: run against embedded Postgres, exercising the real migration files
- Phase 2+: Implementing endpoints, writing unit tests, adding seed files
- All E2E tests run against this backend via docker compose
