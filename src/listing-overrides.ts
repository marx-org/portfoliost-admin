import { Context, Hono } from "hono"
import { sql } from "drizzle-orm"
import type { DB } from "./db/index.js"
import type { components } from "./generated/api-types.js"

let _db: DB | null = null

export type ListingOverrideStatus = "active" | "disabled"

// Contract-typed (#97): the response shapes are the generated components, so a
// drift between this writer and the SPA's reader fails the build rather than
// surfacing as a missing field in production.
type ListingOverrideInput = components["schemas"]["AdminListingOverrideInput"]
type ListingOverrideRow = components["schemas"]["AdminListingOverride"]
type ListingOverridePreview = components["schemas"]["AdminListingOverridePreview"]

// After validation `status` is always present, so the writer never has to feed
// a possibly-undefined enum into SQL.
type ResolvedInput = Omit<ListingOverrideInput, "status"> & { status: ListingOverrideStatus }

export function setListingOverridesDb(db: DB | null) {
  _db = db
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const rows = (result as { rows?: unknown })?.rows
  return (Array.isArray(rows) ? rows : []) as T[]
}

function toOverride(row: Record<string, unknown>): ListingOverrideRow {
  return {
    listingKey: String(row.listing_key),
    ticker: String(row.ticker),
    exchange: String(row.exchange),
    quoteCurrency: String(row.quote_currency),
    assetType: String(row.asset_type),
    status: (String(row.status) || "active") as ListingOverrideStatus,
    rationale: String(row.rationale),
    provenance: String(row.provenance),
    sourceVersion: String(row.source_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    upstreamPresent: row.upstream_present === true || row.upstream_present === "t" || row.upstream_present === 1,
    tickerConflict: row.ticker_conflict === true || row.ticker_conflict === "t" || row.ticker_conflict === 1,
    precedence: "curated",
  }
}

function parseInput(body: unknown): { value: ResolvedInput; error?: never } | { value?: never; error: string } {
  const input = body as Partial<ListingOverrideInput> | null
  const ticker = String(input?.ticker ?? "").trim().toUpperCase()
  const exchange = String(input?.exchange ?? "").trim().toUpperCase()
  const quoteCurrency = String(input?.quoteCurrency ?? "").trim().toUpperCase()
  const assetType = String(input?.assetType ?? "").trim()
  const status = input?.status ?? "active"
  const rationale = String(input?.rationale ?? "").trim()
  const provenance = String(input?.provenance ?? "").trim()

  if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(ticker)) return { error: "ticker is invalid" }
  if (!/^[A-Z0-9]{2,16}$/.test(exchange)) return { error: "exchange is invalid" }
  if (!/^[A-Z]{3}$/.test(quoteCurrency)) return { error: "quoteCurrency must be an ISO-4217 code" }
  if (!assetType || assetType.length > 64) return { error: "assetType is required" }
  if (status !== "active" && status !== "disabled") return { error: "status must be active or disabled" }
  if (!rationale || rationale.length > 2000) return { error: "rationale is required" }
  if (!provenance || provenance.length > 500) return { error: "provenance is required" }

  return { value: { ticker, exchange, quoteCurrency, assetType, status, rationale, provenance } }
}

function actor(c: Context): string {
  const identity = c.get("userIdentity")
  return `${identity.id} <${identity.email}>`
}

async function writeHistory(db: DB, listingKey: string, action: string, snapshot: unknown, by: string) {
  await db.execute(sql`INSERT INTO instruments.curated_listing_override_history
    (listing_key, action, snapshot, actor)
    VALUES (${listingKey}, ${action}, ${JSON.stringify(snapshot)}::jsonb, ${by})`)
}

export function registerListingOverrideRoutes(admin: Hono) {
  admin.get("/listing-overrides", async (c) => {
    if (!_db) return c.json({ error: "DB unavailable" }, 503)
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1)
    const perPage = Math.min(100, Math.max(1, Number(c.req.query("per_page") ?? 50) || 50))
    const search = c.req.query("search")?.trim() ?? ""
    const status = c.req.query("status")?.trim().toLowerCase()
    const searchLike = `%${search}%`
    const statusClause = status === "active" || status === "disabled" ? sql`AND status = ${status}` : sql``

    try {
      const [rowsResult, countResult] = await Promise.all([
        _db.execute(sql`SELECT listing_key, ticker, exchange, quote_currency, asset_type,
          status, rationale, provenance, source_version, created_at, updated_at,
          EXISTS (SELECT 1 FROM instruments.ticker_reference u WHERE u.listing_key = o.listing_key) AS upstream_present,
          (SELECT COUNT(*) FROM instruments.ticker_reference u WHERE u.ticker = o.ticker) > 1 AS ticker_conflict
          FROM instruments.curated_listing_overrides o
          WHERE (ticker ILIKE ${searchLike} OR exchange ILIKE ${searchLike} OR listing_key ILIKE ${searchLike})
          ${statusClause}
          ORDER BY exchange, ticker
          LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`),
        _db.execute(sql`SELECT COUNT(*)::int AS total FROM instruments.curated_listing_overrides
          WHERE (ticker ILIKE ${searchLike} OR exchange ILIKE ${searchLike} OR listing_key ILIKE ${searchLike})
          ${statusClause}`),
      ])
      const total = Number(rowsOf<{ total: number }>(countResult)[0]?.total ?? 0)
      return c.json({ items: rowsOf<Record<string, unknown>>(rowsResult).map(toOverride), pagination: { total, page, per_page: perPage, total_pages: Math.ceil(total / perPage) } })
    } catch (error) {
      console.error("[listing-overrides] list", error)
      return c.json({ error: "Internal error" }, 500)
    }
  })

  admin.post("/listing-overrides", async (c) => {
    if (!_db) return c.json({ error: "DB unavailable" }, 503)
    const parsed = parseInput(await c.req.json().catch(() => null))
    if ("error" in parsed) return c.json({ error: "ValidationError", message: parsed.error }, 422)
    const input = parsed.value
    const listingKey = `${input.exchange}::${input.ticker}`
    try {
      const result = await _db.execute(sql`INSERT INTO instruments.curated_listing_overrides
        (listing_key, ticker, exchange, quote_currency, asset_type, status, rationale, provenance, source_version)
        VALUES (${listingKey}, ${input.ticker}, ${input.exchange}, ${input.quoteCurrency}, ${input.assetType},
          ${input.status}, ${input.rationale}, ${input.provenance}, 'admin')
        RETURNING listing_key, ticker, exchange, quote_currency, asset_type, status, rationale, provenance,
          source_version, created_at, updated_at,
          EXISTS (SELECT 1 FROM instruments.ticker_reference u WHERE u.listing_key = instruments.curated_listing_overrides.listing_key) AS upstream_present,
          (SELECT COUNT(*) FROM instruments.ticker_reference u WHERE u.ticker = instruments.curated_listing_overrides.ticker) > 1 AS ticker_conflict`)
      const row = rowsOf<Record<string, unknown>>(result)[0]
      if (!row) return c.json({ error: "Internal error" }, 500)
      const output = toOverride(row)
      await writeHistory(_db, listingKey, "created", output, actor(c))
      return c.json(output, 201)
    } catch (error) {
      if (String(error).includes("duplicate key")) return c.json({ error: "Conflict", message: "Override already exists" }, 409)
      console.error("[listing-overrides] create", error)
      return c.json({ error: "Internal error" }, 500)
    }
  })

  // #97 — resolve the upstream/conflict picture for a prospective key BEFORE it
  // is saved, so the admin form can show what an override would take precedence
  // over. Read-only; matches the same precedence model as the list endpoint.
  admin.get("/listing-overrides/preview", async (c) => {
    if (!_db) return c.json({ error: "DB unavailable" }, 503)
    const ticker = (c.req.query("ticker") ?? "").trim().toUpperCase()
    const exchange = (c.req.query("exchange") ?? "").trim().toUpperCase()
    if (!ticker || !exchange) {
      return c.json({ error: "ValidationError", message: "ticker and exchange are required" }, 422)
    }
    const listingKey = `${exchange}::${ticker}`
    try {
      const upstream = rowsOf<Record<string, unknown>>(
        await _db.execute(sql`SELECT
          EXISTS (SELECT 1 FROM instruments.ticker_reference
             WHERE listing_key = ${listingKey}) AS upstream_present,
          (SELECT COUNT(*) FROM instruments.ticker_reference
             WHERE ticker = ${ticker}) > 1 AS ticker_conflict`),
      )[0] ?? {}
      const existingRows = rowsOf<Record<string, unknown>>(
        await _db.execute(sql`SELECT listing_key, ticker, exchange, quote_currency, asset_type,
            status, rationale, provenance, source_version, created_at, updated_at,
            EXISTS (SELECT 1 FROM instruments.ticker_reference u WHERE u.listing_key = o.listing_key) AS upstream_present,
            (SELECT COUNT(*) FROM instruments.ticker_reference u WHERE u.ticker = o.ticker) > 1 AS ticker_conflict
          FROM instruments.curated_listing_overrides o
          WHERE o.listing_key = ${listingKey}`),
      )
      const preview: ListingOverridePreview = {
        listingKey,
        ticker,
        exchange,
        upstreamPresent: upstream.upstream_present === true || upstream.upstream_present === "t" || upstream.upstream_present === 1,
        tickerConflict: upstream.ticker_conflict === true || upstream.ticker_conflict === "t" || upstream.ticker_conflict === 1,
        // The upstream reference stores no currency column: a listing's trading
        // currency is derived from its country/venue by the instruments resolver,
        // which this module does not duplicate. Presence and conflict are what a
        // reviewer needs pre-save; the currency is only known post-resolution.
        upstreamCurrency: null,
        existingOverride: existingRows[0] ? toOverride(existingRows[0]) : null,
        precedence: "curated",
      }
      return c.json(preview)
    } catch (error) {
      console.error("[listing-overrides] preview", error)
      return c.json({ error: "Internal error" }, 500)
    }
  })

  admin.put("/listing-overrides/:listingKey", async (c) => {
    if (!_db) return c.json({ error: "DB unavailable" }, 503)
    const parsed = parseInput(await c.req.json().catch(() => null))
    if ("error" in parsed) return c.json({ error: "ValidationError", message: parsed.error }, 422)
    const input = parsed.value
    const listingKey = c.req.param("listingKey").toUpperCase()
    if (listingKey !== `${input.exchange}::${input.ticker}`) return c.json({ error: "ValidationError", message: "listingKey must match exchange and ticker" }, 422)
    try {
      const result = await _db.execute(sql`UPDATE instruments.curated_listing_overrides
        SET ticker = ${input.ticker}, exchange = ${input.exchange}, quote_currency = ${input.quoteCurrency},
          asset_type = ${input.assetType}, status = ${input.status}, rationale = ${input.rationale},
          provenance = ${input.provenance}, source_version = 'admin', updated_at = now()
        WHERE listing_key = ${listingKey}
        RETURNING listing_key, ticker, exchange, quote_currency, asset_type, status, rationale, provenance,
          source_version, created_at, updated_at,
          EXISTS (SELECT 1 FROM instruments.ticker_reference u WHERE u.listing_key = instruments.curated_listing_overrides.listing_key) AS upstream_present,
          (SELECT COUNT(*) FROM instruments.ticker_reference u WHERE u.ticker = instruments.curated_listing_overrides.ticker) > 1 AS ticker_conflict`)
      const row = rowsOf<Record<string, unknown>>(result)[0]
      if (!row) return c.json({ error: "NotFound", message: "Override not found" }, 404)
      const output = toOverride(row)
      await writeHistory(_db, listingKey, "updated", output, actor(c))
      return c.json(output)
    } catch (error) {
      console.error("[listing-overrides] update", error)
      return c.json({ error: "Internal error" }, 500)
    }
  })

  admin.post("/listing-overrides/:listingKey/disable", async (c) => {
    if (!_db) return c.json({ error: "DB unavailable" }, 503)
    const listingKey = c.req.param("listingKey").toUpperCase()
    try {
      const result = await _db.execute(sql`UPDATE instruments.curated_listing_overrides
        SET status = 'disabled', updated_at = now() WHERE listing_key = ${listingKey}
        RETURNING listing_key, ticker, exchange, quote_currency, asset_type, status, rationale, provenance,
          source_version, created_at, updated_at,
          EXISTS (SELECT 1 FROM instruments.ticker_reference u WHERE u.listing_key = instruments.curated_listing_overrides.listing_key) AS upstream_present,
          (SELECT COUNT(*) FROM instruments.ticker_reference u WHERE u.ticker = instruments.curated_listing_overrides.ticker) > 1 AS ticker_conflict`)
      const row = rowsOf<Record<string, unknown>>(result)[0]
      if (!row) return c.json({ error: "NotFound", message: "Override not found" }, 404)
      const output = toOverride(row)
      await writeHistory(_db, listingKey, "disabled", output, actor(c))
      return c.json(output)
    } catch (error) {
      console.error("[listing-overrides] disable", error)
      return c.json({ error: "Internal error" }, 500)
    }
  })

  admin.get("/listing-overrides/:listingKey/history", async (c) => {
    if (!_db) return c.json({ error: "DB unavailable" }, 503)
    const listingKey = c.req.param("listingKey").toUpperCase()
    try {
      const result = await _db.execute(sql`SELECT id, listing_key, action, snapshot, actor, created_at
        FROM instruments.curated_listing_override_history
        WHERE listing_key = ${listingKey} ORDER BY created_at DESC, id DESC`)
      return c.json({ items: rowsOf<Record<string, unknown>>(result).map((row) => ({
        id: Number(row.id), listingKey: String(row.listing_key), action: String(row.action),
        snapshot: row.snapshot, actor: String(row.actor), createdAt: String(row.created_at),
      })) })
    } catch (error) {
      console.error("[listing-overrides] history", error)
      return c.json({ error: "Internal error" }, 500)
    }
  })
}
