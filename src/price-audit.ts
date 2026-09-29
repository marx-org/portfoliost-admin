import { Hono } from "hono"
import {
  callJobshotRun,
  callJobshotStatus,
  getJobRun,
  getJobsDb,
  upsertJobRun,
  type JobshotRunPayload,
} from "./jobs.js"

/**
 * §72 — price audit, triggered manually from the admin panel via jobshot.
 *
 * Structurally the wipe-&-reimport job, deliberately: same jobshot path, same
 * duplicate-run 409, same `upsertJobRun` record, same DB-first status read. The
 * script itself lives in the wallets image (`dist/scripts/price-audit.js`) beside
 * `valuation-audit`, because wallets owns the `portfolios` schema, the FX
 * resolver and the audit pattern. Only the IMAGE is pinned here, so this file
 * stays a thin trigger.
 *
 * The audit is run on demand after a re-import, when venue overrides or a
 * currency are the open question. It reconciles every BUY/SELL against the
 * instrument's own close and reports the symbols that do not line up.
 *
 * No service token is mounted. Like wipe-&-reimport, the job presents the
 * CALLER's Pocket-ID JWT, which the instruments history endpoint already accepts
 * — one fewer Secret in the cluster, and the run is attributed to whoever
 * started it. `price-audit`'s `resolveInstrumentsToken` takes either credential.
 */

export const PRICE_AUDIT_JOB_NAME = "portfoliost-price-audit"
const NAMESPACE = "pfire"
const KIND = "price_audit"

/** Pinned wallets release; must move in step with the wallets HelmRelease. */
export function walletsImage(): string {
  return process.env.WALLETS_IMAGE ?? "ghcr.io/marx2/portfoliost-wallets:v1.1.82"
}

export function buildPriceAuditSpec(
  callerToken: string,
  tolerance?: number,
): JobshotRunPayload {
  const auditArgs = ["--exit-zero"]
  if (typeof tolerance === "number" && Number.isFinite(tolerance)) {
    auditArgs.unshift("--tolerance", String(tolerance))
  }
  return {
    name: PRICE_AUDIT_JOB_NAME,
    namespace: NAMESPACE,
    container: walletsImage(),
    // jobshot wires the whole Secret through `envFrom`, and the pguser secret's
    // key is `uri` — not `DATABASE_URL`. So the entrypoint exports it itself.
    // Without this wrapper the Job starts and immediately cannot connect; the
    // pgloader Job uses the same sh -c shape.
    entrypoint: ["sh", "-c"],
    parameters: [
      `export DATABASE_URL="$uri"; exec node dist/scripts/price-audit.js ${auditArgs.join(" ")}`,
    ],
    secretName: "postgres-pfire-pguser-portfoliost",
    env: {
      INSTRUMENTS_URL: process.env.API_INSTRUMENTS_URL as string,
      // §72.8 — the token goes over WITH its "Bearer " prefix, verbatim from the
      // request. The audit routes credentials with `instrumentsAuthHeaders`, which
      // decides the header by looking for that prefix: Bearer → `Authorization`,
      // anything else → `X-Service-Token`. Passing the stripped token (as
      // sheets-sync does, because its client re-prepends) therefore sent a user
      // JWT to X-Service-Token, instruments compared it against
      // INSTRUMENTS_SERVICE_TOKEN, and every call 401'd. The audit then reported
      // "every trade reconciles" over 219 symbols it had never actually checked.
      //
      // A 401 from that path is indistinguishable from "no data", so the audit
      // also refuses to claim success when nothing was checked.
      INSTRUMENTS_AUTH_TOKEN: callerToken,
    },
    volumes: [],
    volumeMounts: [],
    nodeSelector: {},
    resources: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    },
  }
}

export function registerPriceAuditRoutes(admin: Hono) {
  // POST /api/admin/jobs/price-audit/run  { tolerance?: number }
  admin.post("/jobs/price-audit/run", async (c) => {
    let body: { tolerance?: unknown }
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }
    const tolerance = typeof body.tolerance === "number" ? body.tolerance : undefined
    if (tolerance != null && (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1)) {
      return c.json({ error: "tolerance must be a fraction between 0 and 1" }, 422)
    }

    if (!process.env.API_INSTRUMENTS_URL) {
      return c.json({ error: "API_INSTRUMENTS_URL must be configured" }, 400)
    }

    const authHeader = c.req.header("authorization") ?? ""
    if (!authHeader) {
      return c.json({ error: "Missing Authorization header" }, 401)
    }
    // §72.8 — passed on VERBATIM, prefix included. Do not strip it.
    // `instrumentsAuthHeaders` (wallets) chooses the header by looking for
    // "Bearer ": Bearer → Authorization, anything else → X-Service-Token, which
    // instruments then compares against INSTRUMENTS_SERVICE_TOKEN and rejects.
    // Stripping here — the pattern sheets-sync uses, because its own client
    // re-prepends — put a valid user JWT on the wrong header, so every bar read
    // 401'd, 401 looked exactly like "no bars", and the audit reported
    // "every trade reconciles" over 219 symbols it had checked none of.
    const callerToken = authHeader

    // Duplicate-run guard — jobshot also rejects a running same-name job, but
    // short-circuit so the SPA gets a clean 409.
    try {
      const status = await callJobshotStatus(PRICE_AUDIT_JOB_NAME, NAMESPACE)
      if (status.isRunning || status.status === "Running") {
        return c.json({ error: "A price-audit job is already running" }, 409)
      }
    } catch {
      // jobshot unreachable — proceed anyway
    }

    try {
      const result = await callJobshotRun(buildPriceAuditSpec(callerToken, tolerance))
      const name = result.jobName ?? PRICE_AUDIT_JOB_NAME
      const namespace = result.namespace ?? NAMESPACE

      const db = getJobsDb()
      if (db) {
        await upsertJobRun(db, {
          name,
          namespace,
          kind: KIND,
          param: tolerance != null ? String(tolerance) : null,
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

  // GET /api/admin/jobs/price-audit/log
  // §72.22 — the findings themselves. `/status` already passes `details` through,
  // but it was always null: the audit wrote its report to stdout and nothing
  // persisted it, so the Data quality card could start a run and confirm it
  // finished without being able to show what it found. The script now upserts its
  // report into `admin.job_run.details`, and this is the route that serves it.
  //
  // 404 rather than 200-with-null when there is no run, so the SPA can say "never
  // run" instead of showing an empty report that looks like a clean result.
  admin.get("/jobs/price-audit/log", async (c) => {
    const db = getJobsDb()
    if (!db) return c.json({ error: "NotFound", message: "no database" }, 404)
    const row = await getJobRun(db, PRICE_AUDIT_JOB_NAME).catch(() => null)
    if (!row) return c.json({ error: "NotFound", message: "no price-audit run recorded" }, 404)
    return c.json({
      jobName: row.name,
      status: row.status,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      report: row.details ?? null,
    })
  })

  // GET /api/admin/jobs/price-audit/status
  // DB row first (kept fresh by the backend poller); live jobshot proxy only
  // when the job was never triggered from this backend.
  admin.get("/jobs/price-audit/status", async (c) => {
    const db = getJobsDb()
    if (db) {
      const row = await getJobRun(db, PRICE_AUDIT_JOB_NAME).catch(() => null)
      if (row) {
        return c.json({
          jobName: row.name,
          status: row.status,
          details: row.details ?? null,
          startedAt: row.startedAt ? row.startedAt.toISOString() : null,
        })
      }
    }
    try {
      const live = await callJobshotStatus(PRICE_AUDIT_JOB_NAME, NAMESPACE)
      return c.json({ jobName: PRICE_AUDIT_JOB_NAME, status: live.status, details: live.details ?? null })
    } catch {
      return c.json({ jobName: PRICE_AUDIT_JOB_NAME, status: "Unknown", details: null })
    }
  })
}
