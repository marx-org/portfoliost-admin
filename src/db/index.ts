import { drizzle } from "drizzle-orm/postgres-js"
import type { PgDatabase } from "drizzle-orm/pg-core"
import postgres from "postgres"
import * as schema from "./schema.js"

// Accepts any pg-dialect drizzle instance (postgres-js in prod, PGlite in tests).
export type DB = PgDatabase<any, any, any>

let _client: postgres.Sql | null = null
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null
let _openstClient: postgres.Sql | null = null
let _openstDb: ReturnType<typeof drizzle<typeof schema>> | null = null

export const DEFAULT_DATABASE_URL =
  "postgres://portfoliost:portfoliost@localhost:5432/portfoliost"

export function getDb() {
  if (!_db) {
    _client = postgres(process.env.DATABASE_URL || DEFAULT_DATABASE_URL, { max: 5 })
    _db = drizzle(_client, { schema })
  }
  return _db
}

/**
 * Return the read-only connection to OpenST's database.
 *
 * OpenST is a separate PostgreSQL database in production, even though it is
 * hosted by the same PostgresCluster as portfoliost. Keeping this connection
 * separate prevents `openst.*` queries from accidentally running against the
 * admin database and makes the production topology explicit in configuration.
 */
export function getOpenstDb() {
  if (!_openstDb) {
    const url = process.env.OPENST_DATABASE_URL
    if (!url) throw new Error("OPENST_DATABASE_URL is not set")
    _openstClient = postgres(url, { max: 5 })
    _openstDb = drizzle(_openstClient, { schema })
  }
  return _openstDb
}

export async function closeDb() {
  const client = _client
  const openstClient = _openstClient
  _client = null
  _db = null
  _openstClient = null
  _openstDb = null
  await Promise.all([client?.end(), openstClient?.end()])
}
