import { Hono } from "hono"
import {
  callJobshotRun,
  callJobshotStatus,
  getJobRun,
  getJobsDb,
  upsertJobRun,
  type JobshotRunPayload,
} from "./jobs.js"
import { sheetsSyncImage } from "./sheets-sync.js"

export const CASH_AUDIT_JOB_NAME = "portfoliost-cash-audit"
const NAMESPACE = "pfire"
const KIND = "cash_audit"

export function buildCashAuditSpec(callerToken: string): JobshotRunPayload {
  return {
    name: CASH_AUDIT_JOB_NAME,
    namespace: NAMESPACE,
    container: sheetsSyncImage(),
    entrypoint: ["node", "dist/cash-audit.js"],
    parameters: [],
    secretName: "sheets-sync-secrets",
    env: {
      WALLETS_API_TOKEN: callerToken,
      WALLETS_API_URL: process.env.API_WALLETS_URL as string,
    },
    volumes: [],
    volumeMounts: [],
    nodeSelector: {},
    resources: {
      requests: { cpu: "100m", memory: "256Mi" },
      limits: { cpu: "1", memory: "1Gi" },
    },
  }
}

export function registerCashAuditRoutes(admin: Hono) {
  admin.post("/jobs/cash-audit/run", async (c) => {
    if (!process.env.API_WALLETS_URL) {
      return c.json({ error: "API_WALLETS_URL must be configured" }, 400)
    }
    const authHeader = c.req.header("authorization") ?? ""
    const callerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader
    if (!callerToken) return c.json({ error: "Missing Authorization header" }, 401)

    try {
      const status = await callJobshotStatus(CASH_AUDIT_JOB_NAME, NAMESPACE)
      if (status.isRunning || status.status === "Running") {
        return c.json({ error: "A cash-audit job is already running" }, 409)
      }
    } catch {
      // jobshot unreachable; its run endpoint remains the source of truth.
    }

    try {
      const result = await callJobshotRun(buildCashAuditSpec(callerToken))
      const name = result.jobName ?? CASH_AUDIT_JOB_NAME
      const namespace = result.namespace ?? NAMESPACE
      const db = getJobsDb()
      if (db) {
        await upsertJobRun(db, {
          name,
          namespace,
          kind: KIND,
          param: null,
          status: "Running",
          details: null,
          startedAt: new Date(),
        })
      }
      return c.json({ jobName: name, namespace, status: "Running" })
    } catch (error: any) {
      return c.json({ error: error?.message ?? "Failed to start job" }, 502)
    }
  })

  admin.get("/jobs/cash-audit/log", async (c) => {
    const db = getJobsDb()
    if (!db) return c.json({ error: "NotFound", message: "no database" }, 404)
    const row = await getJobRun(db, CASH_AUDIT_JOB_NAME).catch(() => null)
    if (!row) return c.json({ error: "NotFound", message: "no cash-audit run recorded" }, 404)
    return c.json({
      jobName: row.name,
      status: row.status,
      startedAt: row.startedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt?.toISOString() ?? null,
      report: row.details ?? null,
    })
  })

  admin.get("/jobs/cash-audit/status", async (c) => {
    const db = getJobsDb()
    if (db) {
      const row = await getJobRun(db, CASH_AUDIT_JOB_NAME).catch(() => null)
      if (row) return c.json({ jobName: row.name, status: row.status, details: row.details ?? null })
    }
    try {
      const live = await callJobshotStatus(CASH_AUDIT_JOB_NAME, NAMESPACE)
      return c.json({ jobName: CASH_AUDIT_JOB_NAME, status: live.status, details: live.details ?? null })
    } catch {
      return c.json({ jobName: CASH_AUDIT_JOB_NAME, status: "Unknown", details: null })
    }
  })
}
