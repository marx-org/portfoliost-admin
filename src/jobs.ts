import { Hono } from "hono"
import { randomUUID } from "crypto"
import { existsSync, statSync, unlinkSync } from "fs"
import { join } from "path"
import multer from "multer"
import { IncomingMessage, ServerResponse } from "http"

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

function makeStorage(uploadId: string, dataset: StooqDataset) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, getUploadDir()),
    filename:    (_req, _file, cb) => cb(null, `${dataset}-${uploadId}.zip`),
  })
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
  const script = `set -e
UPLOAD_DIR=/tmp/stooq-uploads
ZIP="$UPLOAD_DIR/${uploadFile}"
LOAD="$UPLOAD_DIR/${loadFile}"
trap 'rm -f "$ZIP" "$LOAD"' EXIT
cat > "$LOAD" << EOF
LOAD ARCHIVE
  FROM $ZIP
  INTO ${pgDsn}
  LOAD CSV
    FROM ALL FILENAMES MATCHING ~/./
    INTO ${pgDsn}
      TARGET TABLE ${table}
      TARGET COLUMNS (ticker, period, date, time, open, high, low, close, volume, openint)
    WITH truncate,
      skip header = 1,
      fields terminated by \\',\\',
      fields not enclosed,
      batch concurrency = 1,
      workers = 2,
      concurrency = 1,
      disable triggers
    SET work_mem to \\'512 MB\\',
        maintenance_work_mem to \\'1024 MB\\';
EOF
pgloader --debug "$LOAD"`

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

// Multer does not integrate directly with Hono's web-standard Request.
// We adapt by dropping down to the raw Node.js IncomingMessage that
// @hono/node-server exposes on c.env.incoming.
function runMulter(
  req: IncomingMessage,
  res: ServerResponse,
  uploadId: string,
  dataset: StooqDataset,
): Promise<{ path: string; size: number }> {
  return new Promise((resolve, reject) => {
    const storage = makeStorage(uploadId, dataset)
    const upload  = multer({
      storage,
      limits: { fileSize: MAX_FILE_SIZE },
      fileFilter: (_req, file, cb) => {
        if (!file.originalname.toLowerCase().endsWith(".zip")) {
          cb(new Error("File must be a .zip archive"))
        } else {
          cb(null, true)
        }
      },
    }).single("file")

    upload(req as any, res as any, (err) => {
      if (err) return reject(err)
      const f = (req as any).file
      if (!f) return reject(new Error("No file received"))
      resolve({ path: f.path, size: f.size })
    })
  })
}

export function registerJobsRoutes(admin: Hono) {
  // POST /api/admin/jobs/stooq-import/upload
  admin.post("/jobs/stooq-import/upload", async (c) => {
    const dataset = c.req.query("dataset") ?? (await c.req.parseBody())["dataset"] as string
    if (!isValidDataset(dataset)) {
      return c.json({ error: `Invalid dataset. Must be one of: ${STOOQ_DATASETS.join(", ")}` }, 400)
    }

    const uploadId = randomUUID()
    const uploadDir = getUploadDir()

    // Ensure upload directory exists
    const { mkdirSync } = await import("fs")
    mkdirSync(uploadDir, { recursive: true })

    const incoming = (c.env as any)?.incoming as IncomingMessage | undefined
    const outgoing = (c.env as any)?.outgoing as ServerResponse | undefined

    if (!incoming || !outgoing) {
      // Fallback: parse with Hono's native formData (no streaming progress, but works in tests)
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
      const destPath = uploadPath(dataset, uploadId)
      const { writeFileSync } = await import("fs")
      writeFileSync(destPath, Buffer.from(await fileBlob.arrayBuffer()))
      return c.json({ uploadId, dataset, sizeBytes: fileBlob.size })
    }

    try {
      const { path: _filePath, size } = await runMulter(incoming, outgoing, uploadId, dataset)
      if (size > MAX_FILE_SIZE) {
        // Shouldn't reach here (multer limits), but guard anyway
        try { unlinkSync(_filePath) } catch { /* ignore */ }
        return c.json({ error: "File exceeds 1 GB limit" }, 413)
      }
      return c.json({ uploadId, dataset, sizeBytes: size })
    } catch (err: any) {
      if (err?.code === "LIMIT_FILE_SIZE") {
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
