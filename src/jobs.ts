import { Hono } from "hono"
import { randomUUID } from "crypto"
import { existsSync, mkdirSync, unlinkSync, createWriteStream } from "fs"
import { join } from "path"
import { pipeline } from "stream/promises"
import { IncomingMessage, ServerResponse } from "http"
import busboy from "busboy"
import { eq } from "drizzle-orm"
import type { DB } from "./db/index.js"
import { jobRun } from "./db/schema.js"

// ── Dataset catalogue ────────────────────────────────────────────────────────

export const STOOQ_DATASETS = [
  "daily_world", "hourly_world", "5min_world",
  "daily_us",    "hourly_us",    "5min_us",
  "daily_uk",    "hourly_uk",    "5min_uk",
  "daily_jp",
  "daily_hk",    "hourly_hk",    "5min_hk",
  "daily_pl",    "hourly_pl",    "5min_pl",
  "daily_hu",    "hourly_hu",    "5min_hu",
  "daily_macro",
] as const

export type StooqDataset = (typeof STOOQ_DATASETS)[number]

function isValidDataset(v: unknown): v is StooqDataset {
  return typeof v === "string" && (STOOQ_DATASETS as readonly string[]).includes(v)
}

// ── Target table mapping (dataset → stooq DB table name) ────────────────────

export function datasetToTable(dataset: StooqDataset): string {
  // Table names are 1:1 with dataset ids (daily_us → daily_us, etc.)
  return dataset
}

// ── Job name helper ──────────────────────────────────────────────────────────

function jobName(dataset: StooqDataset): string {
  return `stooq-importer-${dataset.replace(/_/g, "-")}`
}

// ── multer setup ─────────────────────────────────────────────────────────────

function getUploadDir(): string {
  return process.env.STOOQ_UPLOAD_DIR ?? "/tmp/stooq-uploads"
}

const MAX_FILE_SIZE = 1 * 1024 * 1024 * 1024 // 1 GB

// ── Upload file path helper ──────────────────────────────────────────────────

function uploadPath(dataset: StooqDataset, uploadId: string): string {
  return join(getUploadDir(), `${dataset}-${uploadId}.zip`)
}

// ── jobshot proxy helper ─────────────────────────────────────────────────────

function jotshotUrl(): string {
  return process.env.API_JOBSHOT_URL ?? "http://jobshot:3000"
}

interface JobshotRunPayload {
  name:         string
  namespace:    string
  container:    string
  entrypoint:   string[]
  parameters:   string[]
  secretName:   string
  volumes:      object[]
  volumeMounts: object[]
  nodeSelector: Record<string, string>
  resources:    { requests: { cpu: string; memory: string }; limits: { cpu: string; memory: string } }
}

async function callJobshotRun(payload: JobshotRunPayload): Promise<{ jobName: string; namespace: string }> {
  const res = await fetch(`${jotshotUrl()}/api/run-job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`jobshot run-job failed: ${res.status} ${text}`)
  return JSON.parse(text) as { jobName: string; namespace: string }
}

async function callJobshotStatus(name: string, namespace: string): Promise<{
  status: string; exists: boolean; isRunning: boolean;
  details?: { active: number; succeeded: number; failed: number }
}> {
  const res = await fetch(
    `${jotshotUrl()}/api/job-status/${encodeURIComponent(name)}?namespace=${encodeURIComponent(namespace)}`,
    { signal: AbortSignal.timeout(5_000) },
  )
  if (!res.ok) throw new Error(`jobshot status failed: ${res.status}`)
  return res.json()
}

// ── DB helpers ────────────────────────────────────────────────────────────────

// The DB is injected at server startup via setJobsDb(). In tests it can be
// replaced with a PGlite instance. When null (e.g. during unit tests that don't
// need DB) status routes fall back to NotFound gracefully.
let _db: DB | null = null

export function setJobsDb(db: DB) {
  _db = db
}

type JobStatus = "Running" | "Succeeded" | "Failed" | "NotFound"

interface JobRunRow {
  name: string
  namespace: string
  kind: string
  param: string | null
  status: string
  details: unknown
  startedAt: Date | null
  updatedAt: Date
}

async function upsertJobRun(
  db: DB,
  row: { name: string; namespace: string; kind: string; param: string | null; status: JobStatus; details: unknown; startedAt?: Date },
): Promise<void> {
  const now = new Date()
  await (db as any)
    .insert(jobRun)
    .values({
      name: row.name,
      namespace: row.namespace,
      kind: row.kind,
      param: row.param,
      status: row.status,
      details: row.details ?? null,
      startedAt: row.startedAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: jobRun.name,
      set: {
        status: row.status,
        details: row.details ?? null,
        updatedAt: now,
        // namespace/kind/param only change on a new run — update them too
        namespace: row.namespace,
        kind: row.kind,
        param: row.param,
        startedAt: row.startedAt ?? now,
      },
    })
}

async function getJobRun(db: DB, name: string): Promise<JobRunRow | null> {
  const rows = await (db as any).select().from(jobRun).where(eq(jobRun.name, name)).limit(1)
  return (rows[0] as JobRunRow) ?? null
}

async function getActiveJobRuns(db: DB): Promise<JobRunRow[]> {
  const rows = await (db as any).select().from(jobRun).where(eq(jobRun.status, "Running"))
  return rows as JobRunRow[]
}

// ── Backend poller ────────────────────────────────────────────────────────────

// Polls jobshot every 60 s for all Running jobs, persisting status changes to
// admin.job_run. Runs in the backend process — survives browser session expiry.
let _pollerTimer: ReturnType<typeof setInterval> | null = null

export function startJobPoller(db: DB): void {
  if (_pollerTimer) return // already running
  _db = db
  // Kick off immediately, then every 60 s
  void pollActiveJobs(db)
  _pollerTimer = setInterval(() => void pollActiveJobs(db), 60_000)
}

export function stopJobPoller(): void {
  if (_pollerTimer) {
    clearInterval(_pollerTimer)
    _pollerTimer = null
  }
}

async function pollActiveJobs(db: DB): Promise<void> {
  let active: JobRunRow[]
  try {
    active = await getActiveJobRuns(db)
  } catch (err) {
    console.error("[job-poller] failed to query active jobs:", err)
    return
  }
  if (active.length === 0) return

  await Promise.all(
    active.map(async (row) => {
      try {
        const data = await callJobshotStatus(row.name, row.namespace)
        const newStatus: JobStatus = data.exists
          ? (data.isRunning ? "Running" : (data.status as JobStatus) ?? "NotFound")
          : "NotFound"
        const newDetails = data.details ?? null

        // Only write if something changed. Use sorted-key stringify so JSONB
        // round-trip through the DB (which may reorder object keys) does not
        // produce false positives.
        const sortedStr = (v: unknown) =>
          v == null ? "null" : JSON.stringify(v, Object.keys(v as object).sort())
        const changed =
          newStatus !== row.status ||
          sortedStr(newDetails) !== sortedStr(row.details)
        if (!changed) return

        await upsertJobRun(db, {
          name: row.name,
          namespace: row.namespace,
          kind: row.kind,
          param: row.param,
          status: newStatus,
          details: newDetails,
        })

        console.log(`[job-poller] ${row.name}: ${row.status} → ${newStatus}`)
      } catch (err) {
        // jobshot unreachable — leave row untouched, retry next tick
        console.warn(`[job-poller] could not poll ${row.name}:`, err)
      }
    }),
  )
}

// ── pgloader job spec builder ─────────────────────────────────────────────────

function buildJobSpec(dataset: StooqDataset, uploadId: string): JobshotRunPayload {
  const table      = datasetToTable(dataset)
  const uploadFile = `${dataset}-${uploadId}.zip`
  const loadFile   = `${dataset}-${uploadId}.load`
  const namespace  = "pfire"

  // Shell script run by /bin/sh -c inside the pgloader container.
  // The PGO secret (postgres-pfire-pguser-postgres) is injected via envFrom,
  // so the env var `password` (key name from the PGO secret) is available.
  //
  // Strategy: write the pgloader load file at runtime using a here-document
  // with double-quotes so the shell expands $password. trap cleans up on EXIT.
  const pgDsn = `postgres://postgres:$password@postgres-pfire-primary.pfire.svc:5432/stooq`
  const newTable = `${table}_new`
  const script = `set -e
UPLOAD_DIR=/tmp/stooq-uploads
ZIP="$UPLOAD_DIR/${uploadFile}"
LOAD="$UPLOAD_DIR/${loadFile}"
POST="$UPLOAD_DIR/${loadFile}.post"
trap 'rm -f "$ZIP" "$LOAD" "$POST"' EXIT

cat > "$LOAD" << EOF
LOAD ARCHIVE
  FROM $ZIP
  INTO ${pgDsn}
  BEFORE LOAD DO
    \\$\\$ DROP TABLE IF EXISTS ${newTable}; \\$\\$,
    \\$\\$ CREATE UNLOGGED TABLE ${newTable} (
         ticker   TEXT          NOT NULL,
         period   TEXT          NOT NULL,
         date     DATE          NOT NULL,
         time     TEXT          NOT NULL DEFAULT '000000',
         open     NUMERIC(20,8),
         high     NUMERIC(20,8),
         low      NUMERIC(20,8),
         close    NUMERIC(20,8),
         volume   NUMERIC(28,8),
         openint  NUMERIC(28,8)
       ); \\$\\$
  LOAD CSV
    FROM ALL FILENAMES MATCHING ~/./
    INTO ${pgDsn}
      TARGET TABLE ${newTable}
      TARGET COLUMNS (ticker, period, date, time, open, high, low, close, volume, openint)
    WITH no truncate,
      skip header = 1,
      fields terminated by ',',
      fields not enclosed,
      batch size = 100 MB,
      batch concurrency = 4,
      workers = 8,
      concurrency = 2,
      disable triggers
    SET work_mem to '512 MB',
        maintenance_work_mem to '1024 MB',
        synchronous_commit to 'off',
        statement_timeout to '0',
        lock_timeout to '0',
        idle_in_transaction_session_timeout to '0',
        tcp_keepalives_idle to '60',
        tcp_keepalives_interval to '10',
        tcp_keepalives_count to '6';
EOF
pgloader --debug "$LOAD"

# Post-load: SET LOGGED, build PK, atomic swap.
# Uses LOAD CSV FROM INLINE with a real target table (pgloader_dummy)
# and a single dummy row — zero-row INLINE crashes pgloader (known bug).
# BEFORE LOAD DO runs all post-load SQL; AFTER LOAD DO drops the dummy.
cat > "$POST" << EOF
LOAD CSV
  FROM INLINE
  INTO ${pgDsn}
  TARGET TABLE pgloader_dummy
  BEFORE LOAD DO
    \\$\\$ DROP TABLE IF EXISTS pgloader_dummy; \\$\\$,
    \\$\\$ CREATE TABLE pgloader_dummy (x int); \\$\\$,
    \\$\\$ SET maintenance_work_mem = '2GB'; \\$\\$,
    \\$\\$ SET statement_timeout = 0; \\$\\$,
    \\$\\$ ALTER TABLE ${newTable} SET LOGGED; \\$\\$,
    \\$\\$ DELETE FROM ${newTable} WHERE ctid IN (SELECT ctid FROM (SELECT ctid, row_number() OVER (PARTITION BY ticker, date, time ORDER BY ctid) AS rn FROM ${newTable}) sub WHERE rn > 1); \\$\\$,
    \\$\\$ ALTER TABLE ${newTable} ADD PRIMARY KEY (ticker, date, time); \\$\\$,
    \\$\\$ DO \\$swap\\$ BEGIN DROP TABLE IF EXISTS ${table}; ALTER TABLE ${newTable} RENAME TO ${table}; END \\$swap\\$; \\$\\$
  AFTER LOAD DO
    \\$\\$ DROP TABLE IF EXISTS pgloader_dummy; \\$\\$
  WITH skip header = 0, fields terminated by ',';
1
EOF
pgloader "$POST"
echo "Import of ${table} complete."`

  return {
    name:       jobName(dataset),
    namespace,
    container:  "dimitri/pgloader:ccl.latest",
    entrypoint: ["/bin/sh"],
    parameters: ["-c", script],
    secretName: "postgres-pfire-pguser-postgres",
    volumes: [{
      name: "stooq-upload",
      persistentVolumeClaim: { claimName: "stooq-upload-pvc" },
    }],
    volumeMounts: [{
      name:      "stooq-upload",
      mountPath: "/tmp/stooq-uploads",
    }],
    // Pin to kaczka — largest free SSD (~122 GB), same node as the
    // hostPath PV so the zip is always readable by the pgloader pod.
    nodeSelector: { "kubernetes.io/hostname": "kaczka" },
    resources: {
      requests: { cpu: "500m",  memory: "1Gi" },
      limits:   { cpu: "2000m", memory: "4Gi" },
    },
  }
}

// ── Hono router ──────────────────────────────────────────────────────────────

// Stream a multipart/form-data upload directly to disk using busboy.
// Never buffers the file in memory — pipes the part stream straight to a
// WriteStream on the PVC. Works with both @hono/node-server (c.env.incoming)
// and falls back to a Node.js Readable from the raw request bytes for tests.
function streamUploadToDisk(
  incoming: IncomingMessage,
  destPath: string,
  maxBytes: number,
): Promise<{ filename: string; size: number }> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof busboy>
    try {
      bb = busboy({ headers: incoming.headers, limits: { fileSize: maxBytes } })
    } catch (e) {
      return reject(e)
    }

    let settled = false
    let fileReceived = false
    let totalBytes = 0

    function settle(fn: () => void) {
      if (!settled) { settled = true; fn() }
    }

    bb.on("file", (_fieldname, fileStream, info) => {
      fileReceived = true
      const { filename } = info
      if (!filename.toLowerCase().endsWith(".zip")) {
        fileStream.resume() // drain the stream
        return settle(() => reject(new Error("File must be a .zip archive")))
      }

      const ws = createWriteStream(destPath)

      fileStream.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length
      })

      fileStream.on("limit", () => {
        ws.destroy()
        try { unlinkSync(destPath) } catch { /* ignore */ }
        settle(() => reject(new Error("FILE_TOO_LARGE")))
      })

      pipeline(fileStream, ws)
        .then(() => settle(() => resolve({ filename, size: totalBytes })))
        .catch((err) => settle(() => reject(err)))
    })

    bb.on("error", (err) => settle(() => reject(err)))

    bb.on("finish", () => {
      // finish fires when all parts have been parsed (but pipeline may still
      // be writing). Only reject here if no file field was seen at all.
      if (!fileReceived) {
        settle(() => reject(new Error("No file received")))
      }
    })

    incoming.pipe(bb)
  })
}

export function registerJobsRoutes(admin: Hono) {
  // POST /api/admin/jobs/stooq-import/upload
  // dataset is passed as a query param (?dataset=daily_us) so we never
  // need to parse the multipart body ourselves before streaming.
  admin.post("/jobs/stooq-import/upload", async (c) => {
    const dataset = c.req.query("dataset")
    if (!isValidDataset(dataset)) {
      return c.json({ error: `Invalid dataset. Must be one of: ${STOOQ_DATASETS.join(", ")}` }, 400)
    }

    const uploadId  = randomUUID()
    const uploadDir = getUploadDir()
    mkdirSync(uploadDir, { recursive: true })
    const destPath = uploadPath(dataset, uploadId)

    const incoming = (c.env as any)?.incoming as IncomingMessage | undefined

    if (!incoming) {
      // Test environment: Hono test client sends a Web API Request, not a
      // Node.js IncomingMessage. Parse with formData() — acceptable in tests
      // where files are tiny.
      const formData = await c.req.formData()
      const file = formData.get("file")
      if (!file || typeof file === "string") {
        return c.json({ error: "No file received" }, 400)
      }
      const fileBlob = file as File
      if (!fileBlob.name.toLowerCase().endsWith(".zip")) {
        return c.json({ error: "File must be a .zip archive" }, 400)
      }
      if (fileBlob.size > MAX_FILE_SIZE) {
        return c.json({ error: "File exceeds 1 GB limit" }, 413)
      }
      const { writeFileSync } = await import("fs")
      writeFileSync(destPath, Buffer.from(await fileBlob.arrayBuffer()))
      return c.json({ uploadId, dataset, sizeBytes: fileBlob.size })
    }

    // Production path: stream directly to disk, zero memory buffering.
    try {
      const { size } = await streamUploadToDisk(incoming, destPath, MAX_FILE_SIZE)
      return c.json({ uploadId, dataset, sizeBytes: size })
    } catch (err: any) {
      try { unlinkSync(destPath) } catch { /* ignore */ }
      if (err?.message === "FILE_TOO_LARGE") {
        return c.json({ error: "File exceeds 1 GB limit" }, 413)
      }
      return c.json({ error: err?.message ?? "Upload failed" }, 400)
    }
  })

  // POST /api/admin/jobs/stooq-import/run
  admin.post("/jobs/stooq-import/run", async (c) => {
    let body: { dataset?: string; uploadId?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400)
    }

    const { dataset, uploadId } = body
    if (!isValidDataset(dataset)) {
      return c.json({ error: `Invalid dataset` }, 400)
    }
    if (!uploadId || typeof uploadId !== "string") {
      return c.json({ error: "uploadId is required" }, 400)
    }

    // Verify the file exists on the PVC
    const filePath = uploadPath(dataset, uploadId)
    if (!existsSync(filePath)) {
      return c.json({ error: "Upload not found. Upload the file first." }, 404)
    }

    const name = jobName(dataset)

    // Check if a job is already running
    const jobshotBase = jotshotUrl()
    try {
      const statusRes = await fetch(
        `${jobshotBase}/api/job-status/${encodeURIComponent(name)}?namespace=pfire`,
        { signal: AbortSignal.timeout(5_000) },
      )
      if (statusRes.ok) {
        const statusData = await statusRes.json() as { status: string; isRunning?: boolean }
        if (statusData.isRunning || statusData.status === "Running") {
          return c.json({ error: `A ${name} job is already running` }, 409)
        }
      }
    } catch {
      // jobshot unreachable — proceed anyway (jobshot will reject duplicate itself)
    }

    // Build and submit the job
    const jobSpec = buildJobSpec(dataset, uploadId)
    try {
      const result = await callJobshotRun(jobSpec)
      const resolvedName = result.jobName ?? name
      const resolvedNamespace = result.namespace ?? "pfire"

      // Persist Running status to DB so the backend poller can track it and
      // /status reads from DB rather than proxying jobshot live (D53).
      if (_db) {
        await upsertJobRun(_db, {
          name: resolvedName,
          namespace: resolvedNamespace,
          kind: "stooq_import",
          param: dataset,
          status: "Running",
          details: null,
          startedAt: new Date(),
        })
      }

      return c.json({ jobName: resolvedName, namespace: resolvedNamespace, status: "Running" })
    } catch (err: any) {
      const msg = err?.message ?? "Failed to start job"
      if (msg.includes("already running")) {
        return c.json({ error: msg }, 409)
      }
      return c.json({ error: msg }, 502)
    }
  })

  // GET /api/admin/jobs/stooq-import/status?dataset=daily_us
  admin.get("/jobs/stooq-import/status", async (c) => {
    const dataset = c.req.query("dataset")
    if (!isValidDataset(dataset)) {
      return c.json({ error: "Invalid dataset" }, 400)
    }

    const name = jobName(dataset)

    // D53: read from DB (kept fresh by the backend poller). Fall back to a
    // live jobshot proxy only when the DB is not configured (local dev without
    // DATABASE_URL) or the job has never been triggered from this backend.
    if (_db) {
      const row = await getJobRun(_db, name).catch(() => null)
      if (row) {
        return c.json({
          dataset,
          jobName: row.name,
          status: row.status,
          details: row.details ?? null,
        })
      }
    }

    // Fallback: proxy jobshot live (no DB row yet — job never triggered)
    try {
      const data = await callJobshotStatus(name, "pfire")
      const status = data.exists
        ? (data.isRunning ? "Running" : data.status ?? "NotFound")
        : "NotFound"
      return c.json({ dataset, jobName: name, status, details: data.details ?? null })
    } catch {
      return c.json({ dataset, jobName: name, status: "NotFound", details: null })
    }
  })

  // GET /api/admin/jobs/stooq-import/log
  admin.get("/jobs/stooq-import/log", async (c) => {
    const instrumentsUrl = process.env.API_INSTRUMENTS_URL
    if (!instrumentsUrl) {
      // Return empty log for all datasets when instruments not configured
      return c.json(
        STOOQ_DATASETS.map((d) => ({ dataset: d, latestDate: null, importedAt: null, rowsDeleted: null })),
      )
    }

    try {
      const res = await fetch(`${instrumentsUrl}/api/instruments/internal/stooq-import-log`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) throw new Error(`instruments returned ${res.status}`)
      const data = await res.json() as Array<{
        dataset: string; latestDate: string | null; importedAt: string | null; rowsDeleted: number | null
      }>

      // Build a full response with all datasets, filling in nulls for any not yet imported
      const byDataset = new Map(data.map((e) => [e.dataset, e]))
      return c.json(
        STOOQ_DATASETS.map((d) => byDataset.get(d) ?? { dataset: d, latestDate: null, importedAt: null, rowsDeleted: null }),
      )
    } catch {
      return c.json(
        STOOQ_DATASETS.map((d) => ({ dataset: d, latestDate: null, importedAt: null, rowsDeleted: null })),
      )
    }
  })
}
