/**
 * D82 — Admin read-only surface for the openst savings-bond catalogue and the
 * 12m CPI series. Both tables live in the `openst` Postgres schema (not
 * instruments), so the admin reads them through its dedicated OpenST DB.
 *
 * GET /api/admin/bond-catalogue/bond-series — openst.bond_series rows + count
 * GET /api/admin/bond-catalogue/cpi         — openst.cpi_12m (last N rows) + staleness
 */
import { Hono } from "hono"
import { sql } from "drizzle-orm"
import type { DB } from "./db/index.js"

let _db: DB | null = null

export function setBondCatalogueDb(db: DB | null) {
  _db = db
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const r = result as { rows?: unknown }
  return (Array.isArray(r?.rows) ? r.rows : []) as T[]
}

export interface BondSeriesRow {
  symbol: string
  name: string
  issueDate: string | null
  maturityDate: string | null
  rateRule: string | null
  margin: string | null
}

export interface BondSeriesSummary {
  count: number
  rows: BondSeriesRow[]
}

export interface BondCatalogueError {
  error: "openst_unavailable"
  message: string
}

/** CPI staleness threshold: older than this many days → warning. */
const CPI_STALE_DAYS = 40

export interface CpiRow {
  date: string
  value: string
}

export interface CpiSummary {
  rowCount: number
  stale: boolean
  status: "fresh" | "stale" | "empty"
  lastDate: string | null
  ageDays: number | null
  rows: CpiRow[]
}

export function registerBondCatalogueRoutes(admin: Hono) {
  // GET /api/admin/bond-catalogue/bond-series
  admin.get("/bond-catalogue/bond-series", async (c) => {
    if (!_db) {
      return c.json({
        error: "openst_unavailable",
        message: "OpenST database is not configured",
      } satisfies BondCatalogueError, 503)
    }
    try {
      const countRes = await _db.execute(sql`SELECT COUNT(*)::int AS n FROM openst.bond_series`)
      const count = rowsOf<{ n: number }>(countRes)[0]?.n ?? 0

      const rowsRes = await _db.execute(sql`
        SELECT symbol, name, issue_date, maturity_date, rate_rule, margin
        FROM openst.bond_series
        ORDER BY symbol`)
      const rows: BondSeriesRow[] = rowsOf<Record<string, unknown>>(rowsRes).map((x) => ({
        symbol: String(x.symbol ?? ""),
        name: String(x.name ?? ""),
        issueDate: (x.issue_date as string) ?? null,
        maturityDate: (x.maturity_date as string) ?? null,
        rateRule: (x.rate_rule as string) ?? null,
        margin: (x.margin as string) ?? null,
      }))

      return c.json({ count, rows } satisfies BondSeriesSummary)
    } catch (err) {
      console.error("[bond-catalogue] bond-series", err)
      return c.json({
        error: "openst_unavailable",
        message: "Unable to read the OpenST bond catalogue",
      } satisfies BondCatalogueError, 503)
    }
  })

  // GET /api/admin/bond-catalogue/cpi
  admin.get("/bond-catalogue/cpi", async (c) => {
    if (!_db) {
      return c.json({
        error: "openst_unavailable",
        message: "OpenST database is not configured",
      } satisfies BondCatalogueError, 503)
    }
    try {
      const rowsRes = await _db.execute(sql`
        SELECT date, value FROM openst.cpi_12m ORDER BY date DESC LIMIT 24`)
      const desc = rowsOf<Record<string, unknown>>(rowsRes)
      const rows: CpiRow[] = desc
        .map((x) => ({ date: String(x.date ?? ""), value: String(x.value ?? "") }))
        .reverse() // ascending for display

      const lastDate = desc.length > 0 ? String(desc[0].date ?? "") : null
      let ageDays: number | null = null
      if (lastDate) {
        const last = new Date(`${lastDate}T00:00:00Z`)
        if (Number.isFinite(last.getTime())) {
          ageDays = Math.floor((Date.now() - last.getTime()) / 86_400_000)
        }
      }
      const stale = ageDays !== null && ageDays > CPI_STALE_DAYS
      const status = ageDays === null ? "empty" : stale ? "stale" : "fresh"

      return c.json({
        rowCount: desc.length,
        stale,
        status,
        lastDate,
        ageDays,
        rows,
      } satisfies CpiSummary)
    } catch (err) {
      console.error("[bond-catalogue] cpi", err)
      return c.json({
        error: "openst_unavailable",
        message: "Unable to read the OpenST CPI series",
      } satisfies BondCatalogueError, 503)
    }
  })
}
