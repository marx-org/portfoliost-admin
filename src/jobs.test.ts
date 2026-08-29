import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import app from "./index.js"

const adminHeaders = {
  "X-User-Id": "admin-1",
  "X-User-Email": "admin@example.com",
  "X-User-Groups": "portfoliost_admin",
}

describe("Stooq import jobs API (N)", () => {
  let uploadDir: string
  let origFetch: typeof globalThis.fetch
  let origUploadDir: string | undefined

  beforeEach(() => {
    uploadDir = join(tmpdir(), `stooq-upload-test-${Date.now()}`)
    mkdirSync(uploadDir, { recursive: true })
    origUploadDir = process.env.STOOQ_UPLOAD_DIR
    process.env.STOOQ_UPLOAD_DIR = uploadDir
    process.env.API_JOBSHOT_URL = "http://jobshot-test:3000"
    origFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    if (origUploadDir !== undefined) {
      process.env.STOOQ_UPLOAD_DIR = origUploadDir
    } else {
      delete process.env.STOOQ_UPLOAD_DIR
    }
    delete process.env.API_JOBSHOT_URL
    try { rmSync(uploadDir, { recursive: true }) } catch { /* ignore */ }
  })

  // ── /api/admin/jobs/stooq-import/upload ──────────────────────────────────

  describe("POST /api/admin/jobs/stooq-import/upload", () => {
    it("rejects missing auth", async () => {
      const res = await app.request("/api/admin/jobs/stooq-import/upload", { method: "POST" })
      expect(res.status).toBe(401)
    })

    it("rejects invalid dataset via query param", async () => {
      const form = new FormData()
      form.append("dataset", "invalid_dataset")
      form.append("file", new Blob(["fake"], { type: "application/zip" }), "test.zip")
      const res = await app.request(
        "/api/admin/jobs/stooq-import/upload",
        { method: "POST", headers: adminHeaders, body: form },
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain("Invalid dataset")
    })

    it("rejects non-zip file extension", async () => {
      const form = new FormData()
      form.append("dataset", "daily_us")
      form.append("file", new Blob(["fake"], { type: "application/zip" }), "test.csv")
      const res = await app.request(
        "/api/admin/jobs/stooq-import/upload",
        { method: "POST", headers: adminHeaders, body: form },
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain(".zip")
    })

    it("accepts a valid zip upload and returns uploadId + sizeBytes", async () => {
      const zipContent = Buffer.from("PK\x03\x04") // minimal zip magic bytes
      const form = new FormData()
      form.append("dataset", "daily_us")
      form.append("file", new Blob([zipContent], { type: "application/zip" }), "d_us_txt.zip")
      const res = await app.request(
        "/api/admin/jobs/stooq-import/upload",
        { method: "POST", headers: adminHeaders, body: form },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(typeof body.uploadId).toBe("string")
      expect(body.dataset).toBe("daily_us")
      expect(body.sizeBytes).toBe(zipContent.byteLength)
      // File should be written to uploadDir
      const written = existsSync(join(uploadDir, `daily_us-${body.uploadId}.zip`))
      expect(written).toBe(true)
    })

    it("accepts all 20 valid datasets", async () => {
      const datasets = [
        "daily_world", "hourly_world", "5min_world",
        "daily_us", "hourly_us", "5min_us",
        "daily_uk", "hourly_uk", "5min_uk",
        "daily_jp",
        "daily_hk", "hourly_hk", "5min_hk",
        "daily_pl", "hourly_pl", "5min_pl",
        "daily_hu", "hourly_hu", "5min_hu",
        "daily_macro",
      ]
      for (const dataset of datasets) {
        const form = new FormData()
        form.append("dataset", dataset)
        form.append("file", new Blob(["PK"], { type: "application/zip" }), "test.zip")
        const res = await app.request(
          "/api/admin/jobs/stooq-import/upload",
          { method: "POST", headers: adminHeaders, body: form },
        )
        expect(res.status, `dataset ${dataset} should be accepted`).toBe(200)
      }
    })
  })

  // ── /api/admin/jobs/stooq-import/run ─────────────────────────────────────

  describe("POST /api/admin/jobs/stooq-import/run", () => {
    it("rejects missing auth", async () => {
      const res = await app.request("/api/admin/jobs/stooq-import/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset: "daily_us", uploadId: "x" }),
      })
      expect(res.status).toBe(401)
    })

    it("returns 404 when upload file not found", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ status: "NotFound", exists: false, isRunning: false }), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch

      const res = await app.request("/api/admin/jobs/stooq-import/run", {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ dataset: "daily_us", uploadId: "nonexistent-uuid" }),
      })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toContain("Upload not found")
    })

    it("triggers jobshot and returns Running status", async () => {
      // Create a fake upload file
      const uploadId = "aaaabbbb-cccc-dddd-eeee-ffffffffffff"
      writeFileSync(join(uploadDir, `daily_pl-${uploadId}.zip`), "fake zip")

      const seen: string[] = []
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : (input as Request).url
        seen.push(url)
        if (url.includes("/api/job-status/")) {
          return new Response(
            JSON.stringify({ status: "NotFound", exists: false, isRunning: false }),
            { headers: { "content-type": "application/json" } },
          )
        }
        if (url.includes("/api/run-job")) {
          return new Response(
            JSON.stringify({ message: "Job started", jobName: "stooq-importer-daily-pl", namespace: "pfire" }),
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
      const body = await res.json()
      expect(body.jobName).toBe("stooq-importer-daily-pl")
      expect(body.namespace).toBe("pfire")
      expect(body.status).toBe("Running")
      // Verifies jobshot run-job was called
      expect(seen.some((u) => u.includes("/api/run-job"))).toBe(true)
    })

    it("returns 409 when job is already running", async () => {
      const uploadId = "aaaabbbb-cccc-dddd-eeee-000000000000"
      writeFileSync(join(uploadDir, `daily_us-${uploadId}.zip`), "fake zip")

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({ status: "Running", exists: true, isRunning: true }),
          { headers: { "content-type": "application/json" } },
        )) as typeof fetch

      const res = await app.request("/api/admin/jobs/stooq-import/run", {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ dataset: "daily_us", uploadId }),
      })
      expect(res.status).toBe(409)
    })
  })

  // ── /api/admin/jobs/stooq-import/status ──────────────────────────────────

  describe("GET /api/admin/jobs/stooq-import/status", () => {
    it("rejects missing auth", async () => {
      const res = await app.request("/api/admin/jobs/stooq-import/status?dataset=daily_us")
      expect(res.status).toBe(401)
    })

    it("returns NotFound when jobshot has no job", async () => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({ status: "NotFound", exists: false, isRunning: false }),
          { headers: { "content-type": "application/json" } },
        )) as typeof fetch

      const res = await app.request("/api/admin/jobs/stooq-import/status?dataset=daily_us", {
        headers: adminHeaders,
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.dataset).toBe("daily_us")
      expect(body.status).toBe("NotFound")
    })

    it("returns Running when jobshot reports isRunning", async () => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({ status: "Running", exists: true, isRunning: true, details: { active: 1, succeeded: 0, failed: 0 } }),
          { headers: { "content-type": "application/json" } },
        )) as typeof fetch

      const res = await app.request("/api/admin/jobs/stooq-import/status?dataset=daily_pl", {
        headers: adminHeaders,
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("Running")
      expect(body.details.active).toBe(1)
    })

    it("returns 400 for invalid dataset", async () => {
      const res = await app.request("/api/admin/jobs/stooq-import/status?dataset=nope", {
        headers: adminHeaders,
      })
      expect(res.status).toBe(400)
    })
  })

  // ── /api/admin/jobs/stooq-import/log ─────────────────────────────────────

  describe("GET /api/admin/jobs/stooq-import/log", () => {
    it("rejects missing auth", async () => {
      const res = await app.request("/api/admin/jobs/stooq-import/log")
      expect(res.status).toBe(401)
    })

    it("returns all 20 datasets with nulls when instruments not configured", async () => {
      delete process.env.API_INSTRUMENTS_URL
      const res = await app.request("/api/admin/jobs/stooq-import/log", {
        headers: adminHeaders,
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveLength(20)
      expect(body[0].latestDate).toBeNull()
    })

    it("merges instruments log with full dataset list", async () => {
      process.env.API_INSTRUMENTS_URL = "http://instruments-test:3000"
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify([
            { dataset: "daily_us", latestDate: "2026-08-28", importedAt: "2026-08-28T14:32:00Z", rowsDeleted: 142 },
          ]),
          { headers: { "content-type": "application/json" } },
        )) as typeof fetch

      const res = await app.request("/api/admin/jobs/stooq-import/log", {
        headers: adminHeaders,
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveLength(20)
      const usEntry = body.find((e: any) => e.dataset === "daily_us")
      expect(usEntry.latestDate).toBe("2026-08-28")
      expect(usEntry.rowsDeleted).toBe(142)
      const plEntry = body.find((e: any) => e.dataset === "daily_pl")
      expect(plEntry.latestDate).toBeNull()
    })

    afterEach(() => {
      delete process.env.API_INSTRUMENTS_URL
    })
  })
})
