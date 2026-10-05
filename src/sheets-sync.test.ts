import { describe, it, expect, beforeEach, afterEach } from "vitest"
import app from "./index.js"

const adminHeaders = {
  "X-User-Id": "admin-1",
  "X-User-Email": "admin@example.com",
  "X-User-Groups": "portfoliost_admin",
}

const JWT = "test-jwt-token-123"

let origSyncImage: string | undefined

const authedHeaders = {
  ...adminHeaders,
  "Content-Type": "application/json",
  Authorization: `Bearer ${JWT}`,
}

interface JobshotMock {
  status?: { status: string; exists: boolean; isRunning: boolean; details?: unknown }
  runJobFailMessage?: string
  runJobResponse?: { jobName: string; namespace: string }
  runBodies: unknown[]
}

/**
 * Stub jobshot endpoints. Returns a handle with `runBodies` — the parsed
 * payloads sent to POST /api/run-job, for payload assertions.
 */
function mockJobshot(opts: {
  status?: { status: string; exists: boolean; isRunning: boolean; details?: unknown }
  runJobFailMessage?: string
  runJobResponse?: { jobName: string; namespace: string }
}): JobshotMock {
  const mock: JobshotMock = { runBodies: [] }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url
    if (url.includes("/api/job-status/")) {
      const s = opts.status ?? { status: "NotFound", exists: false, isRunning: false }
      return new Response(JSON.stringify(s), { headers: { "content-type": "application/json" } })
    }
    if (url.includes("/api/run-job")) {
      const bodyText = typeof input === "string"
        ? (init?.body as string) ?? ""
        : await (input as Request).clone().text()
      mock.runBodies.push(JSON.parse(bodyText))
      if (opts.runJobFailMessage) {
        return new Response(JSON.stringify({ error: opts.runJobFailMessage }), { status: 500 })
      }
      const r = opts.runJobResponse ?? { jobName: "portfoliost-sheets-sync", namespace: "pfire" }
      return new Response(JSON.stringify({ message: "Job started", ...r }), {
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("Not Found", { status: 404 })
  }) as typeof fetch
  return mock
}

describe("Sheets sync jobs API (§24.9)", () => {
  let origFetch: typeof globalThis.fetch
  let origWalletsUrl: string | undefined
  let origDbUrl: string | undefined

  beforeEach(() => {
    origFetch = globalThis.fetch
    origWalletsUrl = process.env.API_WALLETS_URL
    origDbUrl = process.env.DATABASE_URL
    origSyncImage = process.env.SHEETS_SYNC_IMAGE
    process.env.API_JOBSHOT_URL = "http://jobshot-test:3000"
    process.env.API_WALLETS_URL = "http://wallets-test:3000"
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test"
    // Set as the HelmRelease does. The fallback was silently three dozen
    // releases behind, so production must supply it and the tests should too.
    process.env.SHEETS_SYNC_IMAGE = "ghcr.io/marx2/portfoliost-sheets-sync:v1.0.37"
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    delete process.env.API_JOBSHOT_URL
    if (origWalletsUrl !== undefined) process.env.API_WALLETS_URL = origWalletsUrl
    else delete process.env.API_WALLETS_URL
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl
    else delete process.env.DATABASE_URL
    if (origSyncImage !== undefined) process.env.SHEETS_SYNC_IMAGE = origSyncImage
    else delete process.env.SHEETS_SYNC_IMAGE
  })

  // ── POST /api/admin/jobs/sheets-sync/run ──────────────────────────────────

  describe("POST /api/admin/jobs/sheets-sync/run", () => {
    it("rejects missing auth", async () => {
      const res = await app.request("/api/admin/jobs/sheets-sync/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
    })

    it("returns 400 when API_WALLETS_URL / DATABASE_URL are not configured", async () => {
      delete process.env.API_WALLETS_URL
      delete process.env.DATABASE_URL
      mockJobshot({})
      const res = await app.request("/api/admin/jobs/sheets-sync/run", {
        method: "POST",
        headers: authedHeaders,
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain("API_WALLETS_URL")
    })

    it("returns 401 when the Authorization header is missing", async () => {
      mockJobshot({})
      const { Authorization: _drop, ...noAuth } = authedHeaders
      const res = await app.request("/api/admin/jobs/sheets-sync/run", {
        method: "POST",
        headers: noAuth,
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
    })

    it("triggers jobshot; payload carries the raw request JWT + env + spec", async () => {
      const mock = mockJobshot({})
      const res = await app.request("/api/admin/jobs/sheets-sync/run", {
        method: "POST",
        headers: authedHeaders,
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ jobName: "portfoliost-sheets-sync", namespace: "pfire", status: "Running" })

      expect(mock.runBodies).toHaveLength(1)
      const payload = mock.runBodies[0] as any
      expect(payload.name).toBe("portfoliost-sheets-sync")
      expect(payload.namespace).toBe("pfire")
      expect(payload.container).toBe("ghcr.io/marx2/portfoliost-sheets-sync:v1.0.37")
      expect(payload.entrypoint).toEqual(["node", "dist/sync.js"])
      expect(payload.parameters).toEqual([])
      expect(payload.secretName).toBe("sheets-sync-secrets")
      // The job's wallets client adds "Bearer " itself — env must be the raw token.
      expect(payload.env.WALLETS_API_TOKEN).toBe(JWT)
      expect(payload.env.WALLETS_API_URL).toBe("http://wallets-test:3000")
      expect(payload.env.INSTRUMENTS_DATABASE_URL).toBe("postgres://test:test@localhost:5432/test")
      expect(payload.resources).toEqual({
        requests: { cpu: "100m", memory: "256Mi" },
        limits:   { cpu: "1",    memory: "1Gi"  },
      })
    })

    it("wipe: true → parameters [\"--wipe\"], param persisted as wipe", async () => {
      const mock = mockJobshot({})
      const res = await app.request("/api/admin/jobs/sheets-sync/run", {
        method: "POST",
        headers: authedHeaders,
        body: JSON.stringify({ wipe: true }),
      })
      expect(res.status).toBe(200)
      const payload = mock.runBodies[0] as any
      expect(payload.parameters).toEqual(["--wipe"])
    })

    it("wipe: false → no parameters", async () => {
      const mock = mockJobshot({})
      const res = await app.request("/api/admin/jobs/sheets-sync/run", {
        method: "POST",
        headers: authedHeaders,
        body: JSON.stringify({ wipe: false }),
      })
      expect(res.status).toBe(200)
      const payload = mock.runBodies[0] as any
      expect(payload.parameters).toEqual([])
    })

    it("returns 409 when a sheets-sync job is already running", async () => {
      mockJobshot({ status: { status: "Running", exists: true, isRunning: true } })
      const res = await app.request("/api/admin/jobs/sheets-sync/run", {
        method: "POST",
        headers: authedHeaders,
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toContain("already running")
    })

    it("returns 409 when jobshot rejects a duplicate run", async () => {
      mockJobshot({ runJobFailMessage: 'Job "portfoliost-sheets-sync" is already running. Please wait.' })
      const res = await app.request("/api/admin/jobs/sheets-sync/run", {
        method: "POST",
        headers: authedHeaders,
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(409)
    })

    it("returns 502 when jobshot fails for another reason", async () => {
      mockJobshot({ runJobFailMessage: "boom" })
      const res = await app.request("/api/admin/jobs/sheets-sync/run", {
        method: "POST",
        headers: authedHeaders,
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(502)
    })
  })

  // ── GET /api/admin/jobs/sheets-sync/status ────────────────────────────────

  describe("GET /api/admin/jobs/sheets-sync/status", () => {
    it("rejects missing auth", async () => {
      const res = await app.request("/api/admin/jobs/sheets-sync/status")
      expect(res.status).toBe(401)
    })

    it("returns NotFound when jobshot has no job", async () => {
      mockJobshot({ status: { status: "NotFound", exists: false, isRunning: false } })
      const res = await app.request("/api/admin/jobs/sheets-sync/status", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.jobName).toBe("portfoliost-sheets-sync")
      expect(body.status).toBe("NotFound")
    })

    it("returns Running when jobshot reports isRunning", async () => {
      mockJobshot({
        status: { status: "Running", exists: true, isRunning: true, details: { active: 1, succeeded: 0, failed: 0 } },
      })
      const res = await app.request("/api/admin/jobs/sheets-sync/status", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("Running")
      expect(body.details.active).toBe(1)
    })

    it("returns NotFound when jobshot is unreachable", async () => {
      globalThis.fetch = (async () => {
        throw new Error("ECONNREFUSED")
      }) as typeof fetch
      const res = await app.request("/api/admin/jobs/sheets-sync/status", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("NotFound")
    })
  })

  // ── GET /api/admin/jobs/sheets-sync/log ───────────────────────────────────

  describe("GET /api/admin/jobs/sheets-sync/log", () => {
    it("rejects missing auth", async () => {
      const res = await app.request("/api/admin/jobs/sheets-sync/log")
      expect(res.status).toBe(401)
    })

    it("returns nulls when no DB is configured", async () => {
      // _db is null in this suite (no setJobsDb call) — empty fallback
      const res = await app.request("/api/admin/jobs/sheets-sync/log", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ startedAt: null, status: null, mode: null })
    })
  })
})
