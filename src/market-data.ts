/**
 * H10 — Admin market-data endpoints.
 *
 * GET  /api/admin/market-data/split-candidates   — pending split candidates
 * POST /api/admin/market-data/split-candidates/:symbol/apply   — apply factor
 * POST /api/admin/market-data/split-candidates/:symbol/dismiss — dismiss
 * GET  /api/admin/market-data/overflow-summary   — price_bars row counts
 */
import { Hono } from "hono"
import type { DB } from "./db/index.js"

let _db: DB | null = null

export function setMarketDataDb(db: DB) {
  _db = db
}

// ── row types ─────────────────────────────────────────────────────────────────

interface SplitCandidate {
  symbol: string
  detectedAt: string
  lastStooqDate: string | null
  lastStooqClose: string | null
  firstOverflowDate: string | null
  firstOverflowClose: string | null
  ratio: string | null
  suggestedFactor: string | null
  suggestedRatio: string | null
  status: string
}

interface OverflowSymbol {
  symbol: string
  rowCount: number
}

// ── helpers ───────────────────────────────────────────────────────────────────

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const r = result as { rows?: unknown }
  return (Array.isArray(r?.rows) ? r.rows : []) as T[]
}

// ── routes ────────────────────────────────────────────────────────────────────

export function registerMarketDataRoutes(admin: Hono) {
  // GET /api/admin/market-data/split-candidates
  admin.get("/market-data/split-candidates", async (c) => {
    if (!_db) return c.json([])
    try {
      const rows = await (_db as any).execute({
        raw: `SELECT symbol, detected_at, last_stooq_date, last_stooq_close,
                     first_overflow_date, first_overflow_close,
                     ratio, suggested_factor, suggested_ratio, status
              FROM instruments.split_candidates
              ORDER BY
                CASE status WHEN 'pending' THEN 0 ELSE 1 END,
                detected_at DESC`,
      } as never)
      const r = rowsOf<Record<string, unknown>>(rows)
      return c.json(
        r.map((x) => ({
          symbol:             String(x.symbol ?? ""),
          detectedAt:         String(x.detected_at ?? ""),
          lastStooqDate:      (x.last_stooq_date as string) ?? null,
          lastStooqClose:     (x.last_stooq_close as string) ?? null,
          firstOverflowDate:  (x.first_overflow_date as string) ?? null,
          firstOverflowClose: (x.first_overflow_close as string) ?? null,
          ratio:              (x.ratio as string) ?? null,
          suggestedFactor:    (x.suggested_factor as string) ?? null,
          suggestedRatio:     (x.suggested_ratio as string) ?? null,
          status:             String(x.status ?? ""),
        })),
      )
    } catch (err) {
      console.error("[market-data] split-candidates", err)
      return c.json([])
    }
  })

  // POST /api/admin/market-data/split-candidates/:symbol/apply
  admin.post("/market-data/split-candidates/:symbol/apply", async (c) => {
    if (!_db) return c.json({ error: "DB unavailable" }, 503)
    const symbol = c.req.param("symbol")
    let factor: number
    try {
      const body = await c.req.json() as { factor: unknown }
      factor = Number(body.factor)
      if (!Number.isFinite(factor) || factor <= 0) throw new Error("bad factor")
    } catch {
      return c.json({ error: "factor must be a positive number" }, 400)
    }
    try {
      // 1. Insert or replace split_adjustment
      const today = new Date().toISOString().slice(0, 10)
      await (_db as any).execute({
        raw: `INSERT INTO instruments.split_adjustments (symbol, detected_at, factor, split_ratio)
              VALUES ('${symbol.replace(/'/g, "''")}', '${today}', ${factor}, NULL)
              ON CONFLICT (symbol, detected_at) DO UPDATE SET factor = excluded.factor`,
      } as never)
      // 2. Mark candidate as applied
      await (_db as any).execute({
        raw: `UPDATE instruments.split_candidates SET status = 'applied', reviewed_at = now()
              WHERE symbol = '${symbol.replace(/'/g, "''")}'`,
      } as never)
      return c.json({ ok: true, symbol, factor, detectedAt: today })
    } catch (err) {
      console.error("[market-data] apply", err)
      return c.json({ error: "Internal error" }, 500)
    }
  })

  // POST /api/admin/market-data/split-candidates/:symbol/dismiss
  admin.post("/market-data/split-candidates/:symbol/dismiss", async (c) => {
    if (!_db) return c.json({ error: "DB unavailable" }, 503)
    const symbol = c.req.param("symbol")
    try {
      await (_db as any).execute({
        raw: `UPDATE instruments.split_candidates SET status = 'dismissed', reviewed_at = now()
              WHERE symbol = '${symbol.replace(/'/g, "''")}' AND status = 'pending'`,
      } as never)
      return c.json({ ok: true, symbol })
    } catch (err) {
      console.error("[market-data] dismiss", err)
      return c.json({ error: "Internal error" }, 500)
    }
  })

  // GET /api/admin/market-data/overflow-summary
  admin.get("/market-data/overflow-summary", async (c) => {
    if (!_db) return c.json({ total: 0, topSymbols: [] })
    try {
      const totalRes = await (_db as any).execute({
        raw: `SELECT COUNT(*)::int AS total FROM instruments.price_bars`,
      } as never)
      const total = rowsOf<{ total: number }>(totalRes)[0]?.total ?? 0

      const topRes = await (_db as any).execute({
        raw: `SELECT symbol, COUNT(*)::int AS row_count
              FROM instruments.price_bars
              GROUP BY symbol
              ORDER BY row_count DESC
              LIMIT 10`,
      } as never)
      const topSymbols: OverflowSymbol[] = rowsOf<{ symbol: string; row_count: number }>(topRes)
        .map((r) => ({ symbol: r.symbol, rowCount: r.row_count }))

      return c.json({ total, topSymbols })
    } catch (err) {
      console.error("[market-data] overflow-summary", err)
      return c.json({ total: 0, topSymbols: [] })
    }
  })
}
