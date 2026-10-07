/**
 * H10 — Admin market-data endpoints.
 *
 * GET  /api/admin/market-data/split-candidates   — pending split candidates
 * POST /api/admin/market-data/split-candidates/:symbol/apply   — apply factor
 * POST /api/admin/market-data/split-candidates/:symbol/dismiss — dismiss
 * GET  /api/admin/market-data/overflow-summary   — price_bars row counts
 */
import { Hono } from "hono"
import { sql } from "drizzle-orm"
import type { DB } from "./db/index.js"

let _db: DB | null = null

export function setMarketDataDb(db: DB | null) {
  _db = db
}

// ── row types ─────────────────────────────────────────────────────────────────

interface SplitCandidate {
  symbol: string
  detectedAt: string
  effectiveDate: string | null
  lastStooqDate: string | null
  lastStooqClose: string | null
  firstOverflowDate: string | null
  firstOverflowClose: string | null
  ratio: string | null
  suggestedFactor: string | null
  suggestedRatio: string | null
  provider: string | null
  providerNumerator: string | null
  providerDenominator: string | null
  providerFactor: string | null
  providerStatus: string
  evidence: unknown
  status: string
  appliedAt: string | null
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

type SplitAdjustmentResult =
  | { portfolioAdjustment: { updatedTransactions: number; affectedPortfolios: number } }
  | { portfolioAdjustmentFailed: true; error: string }

async function applyWalletSplit(symbol: string, quantityFactor: number, effectiveDate: string): Promise<SplitAdjustmentResult> {
  const walletsUrl = process.env.API_WALLETS_URL
  if (!walletsUrl) {
    console.error("[market-data] apply-split: API_WALLETS_URL not configured")
    return { portfolioAdjustmentFailed: true, error: "API_WALLETS_URL not configured" }
  }
  try {
    const res = await fetch(`${walletsUrl}/internal/apply-split`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol, factor: quantityFactor, effectiveDate }),
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    if (!res.ok) {
      console.error("[market-data] apply-split rejected", res.status, text)
      return { portfolioAdjustmentFailed: true, error: `wallets responded ${res.status}: ${text}` }
    }
    const body = JSON.parse(text) as { updatedTransactions: number; affectedPortfolios: number }
    return {
      portfolioAdjustment: {
        updatedTransactions: body.updatedTransactions,
        affectedPortfolios: body.affectedPortfolios,
      },
    }
  } catch (err) {
    console.error("[market-data] apply-split failed", err)
    return { portfolioAdjustmentFailed: true, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerMarketDataRoutes(admin: Hono) {
  // GET /api/admin/market-data/split-candidates
  admin.get("/market-data/split-candidates", async (c) => {
    if (!_db) return c.json([])
    try {
      const rows = await _db.execute(sql`SELECT symbol, detected_at, effective_date, last_stooq_date, last_stooq_close,
                       first_overflow_date, first_overflow_close,
                       ratio, suggested_factor, suggested_ratio, provider,
                       provider_numerator, provider_denominator, provider_factor,
                       provider_status, evidence, status, applied_at
               FROM instruments.split_candidates
               ORDER BY
                 CASE status WHEN 'pending' THEN 0 ELSE 1 END,
                 detected_at DESC`)
      const r = rowsOf<Record<string, unknown>>(rows)
      return c.json(
        r.map((x) => ({
           symbol:             String(x.symbol ?? ""),
           detectedAt:         String(x.detected_at ?? ""),
           effectiveDate:      (x.effective_date as string) ?? null,
          lastStooqDate:      (x.last_stooq_date as string) ?? null,
          lastStooqClose:     (x.last_stooq_close as string) ?? null,
          firstOverflowDate:  (x.first_overflow_date as string) ?? null,
          firstOverflowClose: (x.first_overflow_close as string) ?? null,
          ratio:              (x.ratio as string) ?? null,
          suggestedFactor:    (x.suggested_factor as string) ?? null,
           suggestedRatio:     (x.suggested_ratio as string) ?? null,
           provider:           (x.provider as string) ?? null,
           providerNumerator:  (x.provider_numerator as string) ?? null,
           providerDenominator: (x.provider_denominator as string) ?? null,
           providerFactor:     (x.provider_factor as string) ?? null,
           providerStatus:     String(x.provider_status ?? "manual"),
           evidence:           x.evidence ?? null,
           status:             String(x.status ?? ""),
           appliedAt:          (x.applied_at as string) ?? null,
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
    let effectiveDate: string
    try {
      const body = await c.req.json() as { factor: unknown; effectiveDate?: unknown }
      factor = Number(body.factor)
      if (!Number.isFinite(factor) || factor <= 0) throw new Error("bad factor")
      effectiveDate = String(body.effectiveDate ?? "")
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw new Error("bad effective date")
    } catch {
      return c.json({ error: "factor must be a positive number" }, 400)
    }
    try {
      const db = _db
      // 1. Insert or replace split_adjustment
      const priceFactor = 1 / factor
      await db.execute(sql`INSERT INTO instruments.split_adjustments (symbol, detected_at, factor, split_ratio)
               VALUES (${symbol}, ${effectiveDate}, ${priceFactor}, NULL)
               ON CONFLICT (symbol, detected_at) DO UPDATE SET factor = excluded.factor`)
      // 2. Mark candidate as applied
      await db.execute(sql`UPDATE instruments.split_candidates
               SET status = 'applied', reviewed_at = now(), applied_at = now()
               WHERE symbol = ${symbol}
                 AND (effective_date = ${effectiveDate} OR effective_date IS NULL)`)
      // 3. Restate portfolios in wallets (quantity factor = 1 / price factor).
      // Best-effort: a failed adjustment keeps splitApplied=true so the price
      // bars stay corrected and the call can be retried from the admin panel.
      const adjustment = await applyWalletSplit(symbol, factor, effectiveDate)
      return c.json({ ok: true, splitApplied: true, symbol, factor, effectiveDate, ...adjustment })
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
      await _db.execute(sql`UPDATE instruments.split_candidates SET status = 'dismissed', reviewed_at = now()
               WHERE symbol = ${symbol} AND status = 'pending'`)
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
      const totalRes = await _db.execute(sql`SELECT COUNT(*)::int AS total FROM instruments.price_bars`)
      const total = rowsOf<{ total: number }>(totalRes)[0]?.total ?? 0

      const topRes = await _db.execute(sql`SELECT symbol, COUNT(*)::int AS row_count
               FROM instruments.price_bars
               GROUP BY symbol
               ORDER BY row_count DESC
               LIMIT 10`)
      const topSymbols: OverflowSymbol[] = rowsOf<{ symbol: string; row_count: number }>(topRes)
        .map((r) => ({ symbol: r.symbol, rowCount: r.row_count }))

      return c.json({ total, topSymbols })
    } catch (err) {
      console.error("[market-data] overflow-summary", err)
      return c.json({ total: 0, topSymbols: [] })
    }
  })
}
