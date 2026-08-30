import { Hono } from "hono"
import { randomUUID } from "crypto"
import { existsSync, mkdirSync, unlinkSync, createWriteStream } from "fs"
import { join } from "path"
import { pipeline } from "stream/promises"
import { IncomingMessage, ServerResponse } from "http"
import busboy from "busboy"

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
trap 'rm -f "$ZIP" "$LOAD"' EXIT

cat > "$LOAD" << EOF
LOAD ARCHIVE
  FROM $ZIP
  INTO ${pgDsn}
  BEFORE LOAD DO
    \\$\\$ DROP TABLE IF EXISTS ${newTable}; \\$\\$,
    \\$\\$ CREATE TABLE ${newTable} (
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
      batch concurrency = 1,
      workers = 2,
      concurrency = 1,
      disable triggers
    SET work_mem to '512 MB',
        maintenance_work_mem to '1024 MB',
        statement_timeout to '0',
        lock_timeout to '0',
        idle_in_transaction_session_timeout to '0',
        tcp_keepalives_idle to '60',
        tcp_keepalives_interval to '10',
        tcp_keepalives_count to '6';
EOF
pgloader --debug "$LOAD"

# Build PK on the staging table, then atomically swap it into place.
# The live table (${table}) stays queryable via postgres_fdw right up
# until the RENAME inside the transaction — downtime is < 1 ms.
psql "${pgDsn}" << 'PSQL'
ALTER TABLE ${newTable} ADD PRIMARY KEY (ticker, date, time);
BEGIN;
DROP TABLE IF EXISTS ${table};
ALTER TABLE ${newTable} RENAME TO ${table};
COMMIT;
PSQL
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
    resources: {
      requests: { cpu: "500m",  memory: "1Gi" },
      limits:   { cpu: "2000m", memory: "2Gi" },
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
      return c.json({ jobName: result.jobName ?? name, namespace: result.namespace ?? "pfire", status: "Running" })
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
