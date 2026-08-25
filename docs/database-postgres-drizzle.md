# Proposal: Database Layer — Drizzle + Postgres

**Status**: Accepted
**Date**: 2026-08-21 (supersedes the 2026-08-18 SQLite/Postgres dual-dialect proposal)

## Problem

The real backend (replacing mock endpoints) needs persistent storage for app-specific user data: language preference, UI preferences (chart timeframes, table column configs), custom benchmarks, custom timeframes, and onboarding status. Identity data (email, name) comes from PocketID/lldap via JWT claims and does not need storage.

Multi-user support must be present from the start — the backend is a shared service, not a single-user app. Each user's data is isolated by their JWT `sub` claim.

The mock backend currently serves this data from static JSON seed files with no persistence at all.

## Decision

Use **Postgres everywhere** with **Drizzle ORM**: local development (docker compose), E2E tests, and cluster deployment all run the same dialect. No SQLite, no dual-dialect support.

Rationale:

- The cluster already runs Postgres; a second dialect (SQLite) for dev would mean e2e never exercises the production database and every query must stay in the common SQL subset.
- Maintaining two schema definitions (`sqlite-core` / `pg-core`), two migration sets, and two drivers is permanent overhead that buys nothing once a Postgres server is one `docker compose` service away.
- Drizzle provides: TypeScript-first schema (the schema IS the contract), plain SQL migration files (like Flyway), inferred TypeScript types for select/insert, and a dialect-uniform query builder.

## Schema Design

```ts
// src/db/schema.ts
import { jsonb, pgTable, text } from "drizzle-orm/pg-core"

export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id").primaryKey(), // from JWT claims (sub)
  language: text("language").default("en"),
  uiPreferences: jsonb("ui_preferences"),
  customBenchmarks: jsonb("custom_benchmarks").default([]),
  customTimeframes: jsonb("custom_timeframes").default([]),
  onboardingStatus: jsonb("onboarding_status").default({ completed: false }),
  onboardingDraft: jsonb("onboarding_draft").default({ draft: null }),
  createdAt: text("created_at").notNull(), // ISO 8601 string
  updatedAt: text("updated_at").notNull(), // ISO 8601 string
})
```

Notes:

- Single table. Keyed by user ID from JWT (`sub` claim). Multi-user by design — each row belongs to one user, all queries filter by `userId`.
- **JSONB columns** replace SQLite's JSON-as-text: structured data is stored and read as native JSON, no manual `JSON.stringify`/parse at the storage layer.
- **Timestamps are ISO 8601 text**, matching the API contract byte-for-byte (the mock backend and the real API return the same format). A switch to native `timestamptz` is deliberately deferred until the portfolios/positions tables are designed; if it happens, it happens once, centrally, with `{ mode: "string" }` to keep the wire format stable.

## Migration Workflow

```bash
# Generate migration from schema changes
npx drizzle-kit generate

# Apply to the database pointed at by DATABASE_URL
npx drizzle-kit migrate

# Seed test fixtures (no-op if user_preferences already has rows)
npm run db:seed
```

`drizzle.config.ts` uses `dialect: "postgresql"` and reads `DATABASE_URL`.

## Environments

| Environment | Database | Volatility | Seeding |
|-------------|----------|------------|---------|
| Unit tests | Embedded Postgres ([PGlite](https://github.com/electric-sql/pglite)), in-memory | Fresh per test | Real migrations applied per test |
| Local dev (`npm run dev`) | Postgres via `DATABASE_URL` (e.g. the compose service) | Persistent or volatile as desired | Manual `db:migrate && db:seed` |
| Docker compose | `postgres:17-alpine`, tmpfs-backed | **Volatile — fresh database on every start** | Automatic (`db:migrate && db:seed` in container CMD) |
| Cluster | Existing cluster Postgres instance | PVC-backed, persistent | Migrations run before/at startup; seed fixtures not applied |

Default connection string: `postgres://portfoliost:portfoliost@localhost:5432/portfoliost` (overridden by `DATABASE_URL`).

### Docker compose volatility

The compose Postgres mounts its data directory on tmpfs, so every `docker compose up` starts empty. The backend entrypoint then runs migrations and seeds test fixtures (`test-user-001`, `test-user-002`) deterministically. This matches the testing strategy: dev environments start from a known state with no accumulated cruft.

## What Goes in the DB vs JWT

| Field | Source | Mutability |
|-------|--------|-----------|
| `id` (user ID) | JWT claim `sub` | Read-only |
| `email` | JWT claim | Read-only |
| `firstName`, `lastName` | JWT claim (from lldap) | Read-only |
| `language` | DB (`user_preferences.language`) | Read/write via API |
| `uiPreferences` | DB (JSONB) | Read/write via API |
| `customBenchmarks` | DB (JSONB) | Read/write via API |
| `customTimeframes` | DB (JSONB) | Read/write via API |
| `onboardingStatus` | DB (JSONB) | Read/write via API |
| `isDemoUser` | Hardcoded `false` | Read-only |
| `role` | Hardcoded `"user"` or JWT claim | Read-only |

### Profile Endpoint Behavior

`GET /api/users/profile` merges JWT claims + DB row:
```json
{
  "id": "<from JWT sub>",
  "email": "<from JWT>",
  "firstName": "<from JWT>",
  "lastName": "<from JWT>",
  "language": "<from DB>",
  "isDemoUser": false,
  "createdAt": "<from JWT or DB>"
}
```

`PATCH /api/users/profile` writes only to DB (language and other app-specific fields). Identity fields in the request body are ignored.

## Existing Mock Compatibility

The mock backend serves these endpoints from seed JSON files:

| Mock endpoint | Mock source | Real backend source |
|--------------|-------------|-------------------|
| `GET /api/users/profile` | `users_profile.json` (static) | JWT claims + DB |
| `PATCH /api/users/profile` | In-memory merge | DB only |
| `GET /api/users/preferences` | `users_preferences.json` (static) | DB |
| `PATCH /api/users/preferences` | In-memory merge | DB |
| `GET /api/users/preferences/custom-benchmarks` | `users_preferences_custom_benchmarks.json` | DB (JSONB column) |
| `GET /api/users/preferences/custom-timeframes` | `users_preferences_custom_timeframes.json` | DB (JSONB column) |
| `GET /api/users/onboarding/status` | `users_onboarding_status.json` | DB (JSONB column) |

Response shapes must match exactly — the frontend already consumes these.

## Risks / Considerations

- **Local dev requires a Postgres server.** Mitigated by the compose service; `npm run dev` needs `DATABASE_URL` pointing at it.
- **Multi-user from day one**: Schema is keyed by `userId`. All API endpoints extract the user ID from the JWT `sub` claim and scope queries accordingly. No shared state between users.
- **Auto-provisioning**: When a user authenticates for the first time, the backend upserts a `user_preferences` row with defaults. No separate registration step needed — PocketID/lldap handles user creation.
- **Cluster rollout** is tracked as the final step of the migration plan and will be discussed separately before implementation (credentials, network policy, migration job).
