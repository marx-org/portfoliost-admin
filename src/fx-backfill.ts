/**
 * §72.24 — trigger the FX history backfill.
 *
 * `instruments` has had a one-shot full-history importer since D25:
 * `importHistory` fetches every pair from `DEFAULT_HISTORY_START` (1999-01-04)
 * and upserts it. It is also wired to nothing. The only FX Job in the cluster is
 * `fx-sync`, which runs `syncDaily` — a rolling recent window. So `fx_rates` has
 * only ever grown forward, and a currency added later has no history behind it.
 *
 * That is not a theoretical gap. §72.17 made instruments DROP bars it cannot
 * convert, which is correct — a base-currency price under a target-currency label
 * is how Crypto read 85 PLN one day and ~400 the next. But it has a visible
 * consequence: a position whose pair has no rate before the sync started is
 * absent from the series and present afterwards, and the boundary shows up as a
 * STEP. Two of them are live today, both with no trade to explain them:
 *
 *   IBKR       2961 -> 13291  (+348.9%)  2022-06-20, then stays
 *   IKE Beata 14056 -> 32183  (+129.0%)  2022-05-13, then stays
 *
 * A market move reverses; these do not, so they are not market moves. Backfilling
 * the FX history is the fix — and the code for it has existed the whole time.
 *
 * The Job runs the INSTRUMENTS image, because that is where the script is, and
 * reuses price-audit's shape: jobshot wires the whole pguser Secret through
 * `envFrom` and its key is `uri`, not `DATABASE_URL`, so the entrypoint has to
 * export it itself or the Job starts and immediately cannot connect.
 */

import { Hono } from "hono"
import {
  callJobshotRun,
  callJobshotStatus,
  getJobRun,
  getJobsDb,
  upsertJobRun,
  type JobshotRunPayload,
} from "./jobs.js"

export const FX_BACKFILL_JOB_NAME = "portfoliost-fx-backfill"
const NAMESPACE = "pfire"
const KIND = "fx_backfill"

/** Pinned like the price-audit job: an unpinned tag would change the job's code
 *  under us, and this one writes to the FX table every other price depends on.
 *  Production overrides this with INSTRUMENTS_IMAGE. */
function instrumentsImage(): string {
  return (
    process.env.INSTRUMENTS_IMAGE ??
    "ghcr.io/marx-org/portfoliost-instruments:v1.0.130"
  )
}

export function buildFxBackfillSpec(): JobshotRunPayload {
  return {
    name: FX_BACKFILL_JOB_NAME,
    namespace: NAMESPACE,
    container: instrumentsImage(),
    entrypoint: ["sh", "-c"],
    parameters: [
      // No --start: the script's DEFAULT_HISTORY_START is 1999-01-04, which is
      // the point. Passing an explicit date here would make the Job's coverage a
      // function of a constant in a helm value.
      `export DATABASE_URL="$uri"; exec node dist/scripts/fx-backfill.js`,
    ],
    secretName: "postgres-pfire-pguser-portfoliost",
    env: {
      FRANKFURTER_BASE: process.env.FRANKFURTER_BASE ?? "https://api.frankfurter.dev/v1",
    },
    volumes: [],
    volumeMounts: [],
    nodeSelector: {},
    // Higher limits than price-audit: this one pulls 27 years for every pair at
    // once, rather than making a few hundred small reads.
    resources: {
      requests: { cpu: "200m", memory: "256Mi" },
      limits: { cpu: "1000m", memory: "1Gi" },
    },
  }
}

export function registerFxBackfillRoutes(admin: Hono) {
  // POST /api/admin/jobs/fx-backfill/run
  admin.post("/jobs/fx-backfill/run", async (c) => {
    const db = getJobsDb()
    if (!db) {
      return c.json({ error: "no database configured" }, 503)
    }
    // Mark it Running up front so the SPA shows the same shape as price-audit
    // while jobshot is still accepting the Job.
    await upsertJobRun(db, {
      name: FX_BACKFILL_JOB_NAME,
      namespace: NAMESPACE,
      kind: KIND,
      param: null,
      status: "Running",
      details: { note: "submitted" },
    }).catch(() => undefined)

    try {
      const result = await callJobshotRun(buildFxBackfillSpec())
      return c.json({ jobName: result.jobName, message: "Job started" })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await upsertJobRun(db, {
        name: FX_BACKFILL_JOB_NAME,
        namespace: NAMESPACE,
        kind: KIND,
        param: null,
        status: "Failed",
        details: { error: msg.slice(0, 500) },
      }).catch(() => undefined)
      if (msg.includes("already running")) return c.json({ error: msg }, 409)
      return c.json({ error: msg }, 502)
    }
  })

  // GET /api/admin/jobs/fx-backfill/status
  admin.get("/jobs/fx-backfill/status", async (c) => {
    const db = getJobsDb()
    if (db) {
      const row = await getJobRun(db, FX_BACKFILL_JOB_NAME).catch(() => null)
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
      const live = await callJobshotStatus(FX_BACKFILL_JOB_NAME, NAMESPACE)
      return c.json({ jobName: FX_BACKFILL_JOB_NAME, status: live.status, details: live.details ?? null })
    } catch {
      return c.json({ jobName: FX_BACKFILL_JOB_NAME, status: "NotFound", details: null })
    }
  })
}
