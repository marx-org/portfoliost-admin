import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import app from "./index.js"
import { setBondCatalogueDb } from "./bond-catalogue.js"
import { createTestDb } from "./db/test-db.js"

const adminHeaders = {
  "X-User-Id": "admin-1",
  "X-User-Email": "admin@example.com",
  "X-User-Groups": "portfoliost_admin",
}

let db: Awaited<ReturnType<typeof createTestDb>>["db"]
let client: Awaited<ReturnType<typeof createTestDb>>["client"]

beforeAll(async () => {
  const t = await createTestDb()
  db = t.db
  client = t.client
  // Replicate the openst schema (lives in the openst module, not admin's Drizzle
  // migrations) so the read-only queries can be exercised end-to-end.
  await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS openst`))
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS openst.bond_series (
      symbol TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      series_code TEXT NOT NULL,
      issue_date DATE NOT NULL,
      maturity_date DATE NOT NULL,
      term_months INT NOT NULL,
      rate_rule TEXT NOT NULL,
      margin NUMERIC(6,4) NOT NULL,
      fee_b NUMERIC(6,2) NOT NULL,
      nominal NUMERIC(8,2) NOT NULL DEFAULT 100.00
    )`))
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS openst.cpi_12m (
      date DATE PRIMARY KEY,
      value NUMERIC(8,4) NOT NULL
    )`))
  setBondCatalogueDb(db)
})

afterAll(async () => {
  setBondCatalogueDb(null)
  await client.close()
})

describe("GET /api/admin/bond-catalogue/bond-series (D82)", () => {
  it("returns the bond catalogue rows + count", async () => {
    await db.execute(sql.raw(`
      INSERT INTO openst.bond_series
        (symbol, name, series_code, issue_date, maturity_date, term_months, rate_rule, margin, fee_b, nominal)
      VALUES
        ('ROD1033', '12-letnie ROD', 'ROD', '2023-09-15', '2035-09-15', 144, 'cpi_12m+margin', 1.50, 3.00, 100.00),
        ('EDO0936', '10-letnie EDO', 'EDO', '2026-01-01', '2036-01-01', 120, 'fixed', 6.00, 3.00, 100.00)
      ON CONFLICT (symbol) DO NOTHING`))

    const res = await app.request("/api/admin/bond-catalogue/bond-series", { headers: adminHeaders })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBeGreaterThanOrEqual(2)
    const rod = body.rows.find((r: any) => r.symbol === "ROD1033")
    expect(rod).toBeDefined()
    expect(rod.name).toBe("12-letnie ROD")
    expect(rod.rateRule).toBe("cpi_12m+margin")
    expect(String(rod.margin)).toBe("1.5000")
    expect(rod.maturityDate).toBe("2035-09-15")
  })

  it("requires auth", async () => {
    const res = await app.request("/api/admin/bond-catalogue/bond-series")
    expect(res.status).toBe(401)
  })

  it("returns an error when the OpenST catalogue cannot be read", async () => {
    setBondCatalogueDb({
      execute: async () => {
        throw new Error("relation openst.bond_series does not exist")
      },
    } as any)

    const res = await app.request("/api/admin/bond-catalogue/bond-series", { headers: adminHeaders })
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: "openst_unavailable",
      message: "Unable to read the OpenST bond catalogue",
    })
    setBondCatalogueDb(db)
  })
})

describe("GET /api/admin/bond-catalogue/cpi (D82)", () => {
  it("returns the most recent 24 CPI rows ascending with staleness", async () => {
    // 25 rows so the LIMIT 24 path is exercised; oldest is 60 days ago → stale.
    const today = new Date()
    for (let i = 0; i < 25; i++) {
      const d = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10)
      await db.execute(
        sql.raw(`INSERT INTO openst.cpi_12m (date, value) VALUES ('${d}', 3.${i % 10}) ON CONFLICT (date) DO NOTHING`),
      )
    }
    const res = await app.request("/api/admin/bond-catalogue/cpi", { headers: adminHeaders })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rowCount).toBe(24)
    expect(body.status).toBe("fresh")
    expect(body.rows).toHaveLength(24)
    // ascending: first row is the oldest of the returned window
    expect(body.rows[0].date < body.rows[23].date).toBe(true)
    expect(body.lastDate).toBe(body.rows[23].date)
  })

  it("flags the series stale when the latest date is more than 40 days old", async () => {
    // Wipe the recent rows and leave only an old one.
    await db.execute(sql.raw(`DELETE FROM openst.cpi_12m`))
    await db.execute(sql.raw(`INSERT INTO openst.cpi_12m (date, value) VALUES ('2020-01-01', 1.0)`))
    const res = await app.request("/api/admin/bond-catalogue/cpi", { headers: adminHeaders })
    const body = await res.json()
    expect(body.stale).toBe(true)
    expect(body.status).toBe("stale")
    expect(body.ageDays).toBeGreaterThan(40)
    expect(body.lastDate).toBe("2020-01-01")
  })

  it("reports an empty CPI table without calling it stale", async () => {
    await db.execute(sql.raw(`DELETE FROM openst.cpi_12m`))
    const res = await app.request("/api/admin/bond-catalogue/cpi", { headers: adminHeaders })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      rowCount: 0,
      stale: false,
      status: "empty",
      ageDays: null,
    })
  })

  it("distinguishes an OpenST read failure from stale CPI data", async () => {
    setBondCatalogueDb({
      execute: async () => {
        throw new Error("relation openst.cpi_12m does not exist")
      },
    } as any)

    const res = await app.request("/api/admin/bond-catalogue/cpi", { headers: adminHeaders })
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: "openst_unavailable",
      message: "Unable to read the OpenST CPI series",
    })
    setBondCatalogueDb(db)
  })

  it("requires auth", async () => {
    const res = await app.request("/api/admin/bond-catalogue/cpi")
    expect(res.status).toBe(401)
  })
})
