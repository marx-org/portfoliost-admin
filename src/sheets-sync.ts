import { Hono } from "hono"
import {
  callJobshotRun,
  callJobshotStatus,
  getJobRun,
  getJobsDb,
  upsertJobRun,
  type JobshotRunPayload,
} from "./jobs.js"

// §24.9 — Google Sheets sync, triggered manually from the admin panel via
// jobshot. No CronJob, no static service token: the K8s Job authenticates to
// the wallets import API with the *caller's own* Pocket-ID JWT (the admin API
// is JWT-gated), passed through as WALLETS_API_TOKEN. The job's wallets client
// prepends "Bearer " itself, so the raw token (prefix stripped) goes in env.

const JOB_NAME  = "portfoliost-sheets-sync"
const NAMESPACE = "pfire"
const KIND      = "sheets_sync"

// Pinned release image; override via env for canary/dev.
function sheetsSyncImage(): string {
  return process.env.SHEETS_SYNC_IMAGE ?? "ghcr.io/marx2/portfoliost-sheets-sync:v1.0.2"
}

function buildSheetsSyncSpec(wipe: boolean, callerToken: string): JobshotRunPayload {
  return {
    name:       JOB_NAME,
    namespace:  NAMESPACE,
    container:  sheetsSyncImage(),
    entrypoint: ["node", "dist/sync.js"],
    parameters: wipe ? ["--wipe"] : [],
    secretName: "sheets-sync-secrets",
    env: {
      WALLETS_API_TOKEN: callerToken,
      WALLETS_API_URL:   process.env.API_WALLETS_URL as string,
      // All pfire services share one database — the admin's DATABASE_URL is
      // the Job's read-only ticker_reference lookup (INSTRUMENTS_DATABASE_URL).
      INSTRUMENTS_DATABASE_URL: process.env.DATABASE_URL as string,
    },
    volumes:      [],
    volumeMounts: [],
    nodeSelector: {},
    resources: {
      requests: { cpu: "100m", memory: "256Mi" },
      limits:   { cpu: "1",    memory: "1Gi"  },
    },
  }
}

export function registerSheetsSyncRoutes(admin: Hono) {
  // POST /api/admin/jobs/sheets-sync/run  { wipe?: boolean }
  admin.post("/jobs/sheets-sync/run", async (c) => {
    let body: { wipe?: unknown }
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }
    const wipe = body.wipe === true

    const walletsUrl = process.env.API_WALLETS_URL
    const dbUrl = process.env.DATABASE_URL
    if (!walletsUrl || !dbUrl) {
      return c.json({ error: "API_WALLETS_URL and DATABASE_URL must be configured" }, 400)
    }

    const authHeader = c.req.header("authorization") ?? ""
    const callerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader
    if (!callerToken) {
      return c.json({ error: "Missing Authorization header" }, 401)
    }

    // Duplicate-run guard — jobshot also rejects a running same-name job, but
    // short-circuit so the SPA gets a clean 409.
    try {
      const status = await callJobshotStatus(JOB_NAME, NAMESPACE)
      if (status.isRunning || status.status === "Running") {
        return c.json({ error: "A sheets-sync job is already running" }, 409)
      }
    } catch {
      // jobshot unreachable — proceed anyway
    }

    const spec = buildSheetsSyncSpec(wipe, callerToken)
    try {
      const result = await callJobshotRun(spec)
      const name      = result.jobName ?? JOB_NAME
      const namespace = result.namespace ?? NAMESPACE

      // Persist Running so the backend poller tracks it and /status reads from
      // the DB (D53 pattern, same as stooq_import).
      const db = getJobsDb()
      if (db) {
        await upsertJobRun(db, {
          name,
          namespace,
          kind: KIND,
          param: wipe ? "wipe" : null,
          status: "Running",
          details: null,
          startedAt: new Date(),
        })
      }

      return c.json({ jobName: name, namespace, status: "Running" })
    } catch (err: any) {
      const msg = err?.message ?? "Failed to start job"
      if (msg.includes("already running")) {
        return c.json({ error: msg }, 409)
      }
      return c.json({ error: msg }, 502)
    }
  })

  // GET /api/admin/jobs/sheets-sync/status
  // DB row first (kept fresh by the backend poller); live jobshot proxy only
  // when the job was never triggered from this backend.
  admin.get("/jobs/sheets-sync/status", async (c) => {
    const db = getJobsDb()
    if (db) {
      const row = await getJobRun(db, JOB_NAME).catch(() => null)
      if (row) {
        return c.json({
          jobName:   row.name,
          status:    row.status,
          details:   row.details ?? null,
          startedAt: row.startedAt ? row.startedAt.toISOString() : null,
        })
      }
    }

    try {
      const data = await callJobshotStatus(JOB_NAME, NAMESPACE)
      const status = data.exists
        ? (data.isRunning ? "Running" : data.status ?? "NotFound")
        : "NotFound"
      return c.json({ jobName: JOB_NAME, status, details: data.details ?? null })
    } catch {
      return c.json({ jobName: JOB_NAME, status: "NotFound", details: null })
    }
  })

  // GET /api/admin/jobs/sheets-sync/log
  // Last-run info from admin.job_run (one logical job → one row).
  admin.get("/jobs/sheets-sync/log", async (c) => {
    const empty = { startedAt: null, status: null, mode: null }
    const db = getJobsDb()
    if (!db) return c.json(empty)

    try {
      const row = await getJobRun(db, JOB_NAME)
      if (!row) return c.json(empty)
      return c.json({
        startedAt: row.startedAt ? row.startedAt.toISOString() : null,
        status:    row.status,
        mode:      row.param === "wipe" ? "wipe" : "incremental",
      })
    } catch {
      return c.json(empty)
    }
  })
}
