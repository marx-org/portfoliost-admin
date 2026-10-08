import { describe, expect, it, afterEach } from "vitest"
import app from "./index.js"
import { setListingOverridesDb } from "./listing-overrides.js"

const adminHeaders = {
  "X-User-Id": "admin-1",
  "X-User-Email": "admin@example.com",
  "X-User-Groups": "portfoliost_admin",
}

const row = {
  listing_key: "NYSE::MFC",
  ticker: "MFC",
  exchange: "NYSE",
  quote_currency: "USD",
  asset_type: "Stock",
  status: "active",
  rationale: "NYSE is USD quoted.",
  provenance: "test",
  source_version: "admin",
  created_at: "2026-10-08T00:00:00.000Z",
  updated_at: "2026-10-08T00:00:00.000Z",
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  return Array.isArray(chunks)
    ? chunks.map((chunk) => typeof chunk === "string" ? chunk : String((chunk as { value?: unknown })?.value ?? "?")).join("")
    : String(query)
}

function fakeDb() {
  const queries: string[] = []
  return {
    queries,
    db: {
      execute: async (query: unknown) => {
        const text = sqlText(query)
        queries.push(text)
        if (text.includes("SELECT COUNT(*)::int AS total")) return [{ total: 1 }]
        if (text.includes("AS ticker_conflict") && !text.includes("curated_listing_overrides")) return [{ upstream_present: true, ticker_conflict: false }]
        if (text.includes("curated_listing_override_history") && text.includes("SELECT")) return [{ id: 1, listing_key: "NYSE::MFC", action: "created", snapshot: row, actor: "admin-1 <admin@example.com>", created_at: row.created_at }]
        if (text.includes("curated_listing_override_history")) return []
        if (text.includes("SET status = 'disabled'")) return [{ ...row, status: "disabled" }]
        return [row]
      },
    } as never,
  }
}

afterEach(() => setListingOverridesDb(null))

describe("listing override admin routes", () => {
  it("requires the admin group", async () => {
    const response = await app.request("/api/admin/listing-overrides")
    expect(response.status).toBe(401)
  })

  it("rejects invalid override input", async () => {
    setListingOverridesDb(fakeDb().db)
    const response = await app.request("/api/admin/listing-overrides", {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ ticker: "MFC", exchange: "NYSE", quoteCurrency: "US", assetType: "Stock" }),
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: "ValidationError" })
  })

  it("supports list, create, update, disable, and history", async () => {
    const { db, queries } = fakeDb()
    setListingOverridesDb(db)

    const list = await app.request("/api/admin/listing-overrides?search=MFC", { headers: adminHeaders })
    expect(list.status).toBe(200)
    expect((await list.json()).items[0]).toMatchObject({ listingKey: "NYSE::MFC", quoteCurrency: "USD" })

    const input = {
      ticker: "MFC",
      exchange: "NYSE",
      quoteCurrency: "USD",
      assetType: "Stock",
      rationale: "NYSE is USD quoted.",
      provenance: "test",
    }
    const created = await app.request("/api/admin/listing-overrides", {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    expect(created.status).toBe(201)

    const updated = await app.request("/api/admin/listing-overrides/NYSE::MFC", {
      method: "PUT",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ ...input, rationale: "Updated rationale." }),
    })
    expect(updated.status).toBe(200)

    const disabled = await app.request("/api/admin/listing-overrides/NYSE::MFC/disable", {
      method: "POST",
      headers: adminHeaders,
    })
    expect(disabled.status).toBe(200)
    expect((await disabled.json()).status).toBe("disabled")

    const history = await app.request("/api/admin/listing-overrides/NYSE::MFC/history", { headers: adminHeaders })
    expect(history.status).toBe(200)
    expect((await history.json()).items[0]).toMatchObject({ action: "created", actor: "admin-1 <admin@example.com>" })
    expect(queries.filter((query) => query.includes("curated_listing_override_history")).length).toBeGreaterThan(1)
  })

  it("previews upstream presence, conflict and precedence before saving", async () => {
    const fake = fakeDb()
    setListingOverridesDb(fake.db)
    const preview = await app.request("/api/admin/listing-overrides/preview?ticker=mfc&exchange=nyse", { headers: adminHeaders })
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({
      listingKey: "NYSE::MFC",
      ticker: "MFC",
      exchange: "NYSE",
      upstreamPresent: true,
      tickerConflict: false,
      upstreamCurrency: null,
      precedence: "curated",
    })
    // Regression (#97): the upstream reference has no quote_currency column — it
    // is derived by the instruments resolver, not stored. Selecting it 500s live.
    const upstreamQuery = fake.queries.find((q) => q.includes("instruments.ticker_reference") && !q.includes("curated_listing_overrides"))
    expect(upstreamQuery).toBeDefined()
    expect(upstreamQuery).not.toMatch(/quote_currency\s+FROM\s+instruments\.ticker_reference/i)
  })

  it("rejects a preview without ticker or exchange", async () => {
    setListingOverridesDb(fakeDb().db)
    const response = await app.request("/api/admin/listing-overrides/preview?ticker=MFC", { headers: adminHeaders })
    expect(response.status).toBe(422)
  })
})
