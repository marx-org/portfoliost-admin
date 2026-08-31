/**
 * DB-backed job tracking tests (D53).
 * Uses PGlite (in-process Postgres) so no external DB is needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { eq } from "drizzle-orm"
import { createTestDb } from "./test-db.js"
import { jobRun } from "./schema.js"
import { setJobsDb, startJobPoller, stopJobPoller } from "../jobs.js"
import app from "../index.js"

const adminHeaders = {
  "X-User-Id": "admin-1",
  "X-User-Email": "admin@example.com",
  "X-User-Groups": "portfoliost_admin",
}

// ── Migration smoke test ──────────────────────────────────────────────────────

describe("admin DB migration", () => {
  it("creates admin.job_run table via PGlite migration", async () => {
    const { db } = await createTestDb()
    // Insert + read back to confirm table exists with correct shape
    const now = new Date()
    await (db as any).insert(jobRun).values({
      name: "test-job",
      namespace: "pfire",
      kind: "stooq_import",
      param: "daily_us",
      status: "Running",
      details: null,
      startedAt: now,
      updatedAt: now,
    })
    const rows = await (db as any).select().from(jobRun).where(eq(jobRun.name, "test-job"))
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("Running")
    expect(rows[0].param).toBe("daily_us")
  })
})

// ── /run persists Running row ─────────────────────────────────────────────────

describe("POST /api/admin/jobs/stooq-import/run — DB persistence (D53)", () => {
  let uploadDir: string
  let origFetch: typeof globalThis.fetch

  beforeEach(async () => {
    uploadDir = join(tmpdir(), `stooq-db-test-${Date.now()}`)
    mkdirSync(uploadDir, { recursive: true })
    process.env.STOOQ_UPLOAD_DIR = uploadDir
    process.env.API_JOBSHOT_URL = "http://jobshot-test:3000"
    origFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    stopJobPoller()
    setJobsDb(null as any)
    delete process.env.STOOQ_UPLOAD_DIR
    delete process.env.API_JOBSHOT_URL
    try { rmSync(uploadDir, { recursive: true }) } catch { /* ignore */ }
  })

  it("upserts a Running row in job_run when run succeeds", async () => {
    const { db } = await createTestDb()
    setJobsDb(db as any)

    const uploadId = "bbbb0000-0000-0000-0000-000000000000"
    writeFileSync(join(uploadDir, `daily_pl-${uploadId}.zip`), "fake zip")

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url
      if (url.includes("/api/job-status/")) {
        return new Response(JSON.stringify({ status: "NotFound", exists: false, isRunning: false }), {
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/api/run-job")) {
        return new Response(
          JSON.stringify({ jobName: "stooq-importer-daily-pl", namespace: "pfire" }),
          { headers: { "content-type": "application/json" } },
        )
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch

    const res = await app.request("/api/admin/jobs/stooq-import/run", {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ dataset: "daily_pl", uploadId }),
    })
    expect(res.status).toBe(200)

    const rows = await (db as any).select().from(jobRun).where(eq(jobRun.name, "stooq-importer-daily-pl"))
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("Running")
    expect(rows[0].param).toBe("daily_pl")
    expect(rows[0].kind).toBe("stooq_import")
    expect(rows[0].namespace).toBe("pfire")
  })
})

// ── /status reads from DB ─────────────────────────────────────────────────────

describe("GET /api/admin/jobs/stooq-import/status — reads DB row (D53)", () => {
  afterEach(() => {
    stopJobPoller()
    setJobsDb(null as any)
  })

  it("returns persisted Running status from DB without calling jobshot", async () => {
    const { db } = await createTestDb()
    setJobsDb(db as any)

    const now = new Date()
    await (db as any).insert(jobRun).values({
      name: "stooq-importer-daily-us",
      namespace: "pfire",
      kind: "stooq_import",
      param: "daily_us",
      status: "Running",
      details: { active: 1, succeeded: 0, failed: 0 },
      startedAt: now,
      updatedAt: now,
    })

    // Verify jobshot is NOT called
    let jobshotCalled = false
    globalThis.fetch = (async () => {
      jobshotCalled = true
      return new Response("should not be called", { status: 500 })
    }) as typeof fetch

    const res = await app.request("/api/admin/jobs/stooq-import/status?dataset=daily_us", {
      headers: adminHeaders,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("Running")
    expect(body.dataset).toBe("daily_us")
    expect(body.details).toEqual({ active: 1, succeeded: 0, failed: 0 })
    expect(jobshotCalled).toBe(false)
  })

  it("returns Succeeded status persisted by the poller", async () => {
    const { db } = await createTestDb()
    setJobsDb(db as any)

    const now = new Date()
    await (db as any).insert(jobRun).values({
      name: "stooq-importer-daily-pl",
      namespace: "pfire",
      kind: "stooq_import",
      param: "daily_pl",
      status: "Succeeded",
      details: { active: 0, succeeded: 1, failed: 0 },
      startedAt: now,
      updatedAt: now,
    })

    const res = await app.request("/api/admin/jobs/stooq-import/status?dataset=daily_pl", {
      headers: adminHeaders,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("Succeeded")
  })

  it("falls back to NotFound when no DB row exists", async () => {
    const { db } = await createTestDb()
    setJobsDb(db as any)

    // No row inserted — poller hasn't seen this job yet
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "NotFound", exists: false, isRunning: false }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch

    const res = await app.request("/api/admin/jobs/stooq-import/status?dataset=daily_world", {
      headers: adminHeaders,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("NotFound")
  })
})

// ── Backend poller transitions status ─────────────────────────────────────────

describe("backend poller (D53)", () => {
  afterEach(() => {
    stopJobPoller()
    setJobsDb(null as any)
  })

  it("updates Running → Succeeded when jobshot reports succeeded", async () => {
    const { db } = await createTestDb()

    const now = new Date()
    await (db as any).insert(jobRun).values({
      name: "stooq-importer-daily-us",
      namespace: "pfire",
      kind: "stooq_import",
      param: "daily_us",
      status: "Running",
      details: { active: 1, succeeded: 0, failed: 0 },
      startedAt: now,
      updatedAt: now,
    })

    process.env.API_JOBSHOT_URL = "http://jobshot-test:3000"
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ status: "Succeeded", exists: true, isRunning: false, details: { active: 0, succeeded: 1, failed: 0 } }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch

    // Start poller and wait for first tick (immediate kick-off)
    startJobPoller(db as any)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const rows = await (db as any).select().from(jobRun).where(eq(jobRun.name, "stooq-importer-daily-us"))
    expect(rows[0].status).toBe("Succeeded")
    expect((rows[0].details as any).succeeded).toBe(1)

    delete process.env.API_JOBSHOT_URL
  })

  it("does not write when status is unchanged", async () => {
    const { db } = await createTestDb()

    const fixedTime = new Date("2026-08-31T10:00:00Z")
    await (db as any).insert(jobRun).values({
      name: "stooq-importer-daily-pl",
      namespace: "pfire",
      kind: "stooq_import",
      param: "daily_pl",
      status: "Running",
      details: { active: 1, succeeded: 0, failed: 0 },
      startedAt: fixedTime,
      updatedAt: fixedTime,
    })

    process.env.API_JOBSHOT_URL = "http://jobshot-test:3000"
    // Same status, same details — no change
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ status: "Running", exists: true, isRunning: true, details: { active: 1, succeeded: 0, failed: 0 } }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch

    startJobPoller(db as any)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const rows = await (db as any).select().from(jobRun).where(eq(jobRun.name, "stooq-importer-daily-pl"))
    // updatedAt should remain fixedTime (no write occurred)
    expect(rows[0].updatedAt.toISOString()).toBe(fixedTime.toISOString())

    delete process.env.API_JOBSHOT_URL
  })
})

// ── /log reads from job_run ───────────────────────────────────────────────────

describe("GET /api/admin/jobs/stooq-import/log — reads job_run (D53)", () => {
  afterEach(() => {
    stopJobPoller()
    setJobsDb(null as any)
  })

  it("returns all 20 datasets; triggered ones show importedAt from started_at", async () => {
    const { db } = await createTestDb()
    setJobsDb(db as any)

    const start = new Date("2026-08-31T22:00:00Z")
    await (db as any).insert(jobRun).values({
      name: "stooq-importer-daily-pl",
      namespace: "pfire",
      kind: "stooq_import",
      param: "daily_pl",
      status: "Succeeded",
      details: null,
      startedAt: start,
      updatedAt: start,
    })

    const res = await app.request("/api/admin/jobs/stooq-import/log", {
      headers: {
        "X-User-Id": "admin-1",
        "X-User-Email": "admin@example.com",
        "X-User-Groups": "portfoliost_admin",
      },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(20)

    const plEntry = body.find((e: any) => e.dataset === "daily_pl")
    expect(plEntry.importedAt).toBe("2026-08-31T22:00:00.000Z")
    expect(plEntry.latestDate).toBeNull()   // post-import hook not yet wired
    expect(plEntry.rowsDeleted).toBeNull()  // same

    const usEntry = body.find((e: any) => e.dataset === "daily_us")
    expect(usEntry.importedAt).toBeNull()   // never triggered
    expect(usEntry.latestDate).toBeNull()
  })
})
