import { describe, it, expect } from "vitest"
import app from "./index.js"
import { setMarketDataDb } from "./market-data.js"

const adminHeaders = {
  "X-User-Id": "admin-1",
  "X-User-Email": "admin@example.com",
  "X-User-Groups": "portfoliost_admin",
}

const today = new Date().toISOString().slice(0, 10)

function sqlToString(q: unknown): string {
  const obj = q as { queryChunks?: unknown[] }
  if (obj && Array.isArray(obj.queryChunks)) {
    return obj.queryChunks
      .map((c) => {
        if (typeof c === "string") return c
        const p = c as { value?: unknown }
        return p?.value != null ? String(p.value) : "?"
      })
      .join("")
  }
  return String(q)
}

function fakeDb() {
  const executed: string[] = []
  return {
    executed,
    db: {
      execute: async (query: unknown) => {
        executed.push(sqlToString(query))
        return []
      },
    } as never,
  }
}

describe("POST /api/admin/market-data/split-candidates/:symbol/apply (§23.7)", () => {
  it("fires the wallets apply-split hook with the quantity factor after the DB writes", async () => {
    const { executed, db } = fakeDb()
    setMarketDataDb(db)
    process.env.API_WALLETS_URL = "http://wallets:3000"
    const calls: Array<{ url: string; body: unknown }> = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null })
      return new Response(JSON.stringify({ updatedTransactions: 3, affectedPortfolios: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    try {
      const res = await app.request("/api/admin/market-data/split-candidates/AAPL/apply", {
        method: "POST",
        headers: { ...adminHeaders, "content-type": "application/json" },
         body: JSON.stringify({ factor: 2, effectiveDate: today }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        ok: true,
        splitApplied: true,
        symbol: "AAPL",
         factor: 2,
         effectiveDate: today,
        portfolioAdjustment: { updatedTransactions: 3, affectedPortfolios: 2 },
      })

      expect(executed).toHaveLength(2)
      expect(executed[0]).toContain("INSERT INTO instruments.split_adjustments")
      expect(executed[1]).toContain("SET status = 'applied'")

      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe("http://wallets:3000/internal/apply-split")
       expect(calls[0].body).toEqual({ symbol: "AAPL", factor: 2, effectiveDate: today, source: "admin" })
    } finally {
      globalThis.fetch = origFetch
      delete process.env.API_WALLETS_URL
      setMarketDataDb(null)
    }
  })

  it("keeps splitApplied=true and reports portfolioAdjustmentFailed when the wallets fetch fails", async () => {
    const { db } = fakeDb()
    setMarketDataDb(db)
    process.env.API_WALLETS_URL = "http://wallets:3000"
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as typeof fetch

    try {
      const res = await app.request("/api/admin/market-data/split-candidates/MSFT/apply", {
        method: "POST",
        headers: { ...adminHeaders, "content-type": "application/json" },
         body: JSON.stringify({ factor: 4, effectiveDate: today }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.splitApplied).toBe(true)
      expect(body.portfolioAdjustmentFailed).toBe(true)
      expect(body.error).toContain("ECONNREFUSED")
    } finally {
      globalThis.fetch = origFetch
      delete process.env.API_WALLETS_URL
      setMarketDataDb(null)
    }
  })

  it("reports portfolioAdjustmentFailed when wallets responds non-2xx", async () => {
    const { db } = fakeDb()
    setMarketDataDb(db)
    process.env.API_WALLETS_URL = "http://wallets:3000"
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "ValidationError" }), { status: 422 })) as typeof fetch

    try {
      const res = await app.request("/api/admin/market-data/split-candidates/IBM/apply", {
        method: "POST",
        headers: { ...adminHeaders, "content-type": "application/json" },
         body: JSON.stringify({ factor: 0.5, effectiveDate: today }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.splitApplied).toBe(true)
      expect(body.portfolioAdjustmentFailed).toBe(true)
      expect(body.error).toContain("422")
    } finally {
      globalThis.fetch = origFetch
      delete process.env.API_WALLETS_URL
      setMarketDataDb(null)
    }
  })
})
