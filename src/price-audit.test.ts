import { describe, it, expect, beforeEach, afterEach } from "vitest"
import app from "./index.js"
import { buildPriceAuditSpec, PRICE_AUDIT_JOB_NAME, walletsImage } from "./price-audit.js"

const adminHeaders = {
  "X-User-Id": "admin-1",
  "X-User-Email": "admin@example.com",
  "X-User-Groups": "portfoliost_admin",
}
const JWT = "caller-jwt-abc"
const authed = {
  ...adminHeaders,
  "Content-Type": "application/json",
  Authorization: `Bearer ${JWT}`,
}

/** Stub jobshot; returns the parsed run-job payloads for assertion. */
function mockJobshot(opts: { status?: { status: string; exists: boolean; isRunning: boolean } } = {}) {
  const runBodies: any[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url
    if (url.includes("/api/job-status/")) {
      return new Response(
        JSON.stringify(opts.status ?? { status: "NotFound", exists: false, isRunning: false }),
        { headers: { "content-type": "application/json" } },
      )
    }
    if (url.includes("/api/run-job")) {
      const text = typeof input === "string" ? ((init?.body as string) ?? "") : await (input as Request).clone().text()
      runBodies.push(JSON.parse(text))
      return new Response(
        JSON.stringify({ message: "Job started", jobName: PRICE_AUDIT_JOB_NAME, namespace: "pfire" }),
        { headers: { "content-type": "application/json" } },
      )
    }
    return new Response("Not Found", { status: 404 })
  }) as typeof fetch
  return runBodies
}

describe("Price audit job API (§72)", () => {
  let origFetch: typeof globalThis.fetch

  beforeEach(() => {
    origFetch = globalThis.fetch
    process.env.API_INSTRUMENTS_URL = "http://portfoliost-instruments.pfire.svc:3000"
  })
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it("§72.8: hands the token over WITH its Bearer prefix", async () => {
    // The job got a 401 on every call in PROD and reported a clean result. The
    // token was valid; it was sent as X-Service-Token instead of Authorization
    // because it arrived stripped. sheets-sync strips for the same reason — its
    // client re-prepends — and copying that pattern here was the bug.
    const bodies = mockJobshot()
    await app.request("/api/admin/jobs/price-audit/run", { method: "POST", headers: authed, body: "{}" })
    const token: string = bodies[0].env.INSTRUMENTS_AUTH_TOKEN
    expect(token.startsWith("Bearer "), `token must keep its prefix, got: ${token.slice(0, 12)}…`).toBe(true)
    expect(token).toBe(`Bearer ${JWT}`)
  })

  it("starts the job in the WALLETS image with the caller's token", async () => {
    const bodies = mockJobshot()
    const res = await app.request("/api/admin/jobs/price-audit/run", { method: "POST", headers: authed, body: "{}" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ jobName: PRICE_AUDIT_JOB_NAME, status: "Running" })

    expect(bodies).toHaveLength(1)
    const spec = bodies[0]
    expect(spec.container).toBe(walletsImage())
    expect(spec.container).toContain("portfoliost-wallets")
    // The caller's own JWT, not a service token the cluster would have to mount.
    expect(spec.env.INSTRUMENTS_AUTH_TOKEN).toBe(`Bearer ${JWT}`)
    expect(spec.env.INSTRUMENTS_SERVICE_TOKEN).toBeUndefined()
  })

  it("exports DATABASE_URL from the pguser secret's `uri` key", async () => {
    // jobshot wires the whole Secret through envFrom, so the key is `uri` — there
    // is no DATABASE_URL unless the entrypoint exports it. Without the wrapper
    // the Job starts and immediately cannot connect.
    const bodies = mockJobshot()
    await app.request("/api/admin/jobs/price-audit/run", { method: "POST", headers: authed, body: "{}" })
    const spec = bodies[0]
    expect(spec.secretName).toBe("postgres-pfire-pguser-portfoliost")
    expect(spec.entrypoint).toEqual(["sh", "-c"])
    expect(spec.parameters[0]).toContain('export DATABASE_URL="$uri"')
    expect(spec.parameters[0]).toContain("dist/scripts/price-audit.js")
  })

  it("passes --exit-zero so findings are a successful Job, not a red failure", async () => {
    const bodies = mockJobshot()
    await app.request("/api/admin/jobs/price-audit/run", { method: "POST", headers: authed, body: "{}" })
    expect(bodies[0].parameters[0]).toContain("--exit-zero")
  })

  it("forwards a tolerance when given one, and rejects a nonsense one", async () => {
    const bodies = mockJobshot()
    await app.request("/api/admin/jobs/price-audit/run", {
      method: "POST", headers: authed, body: JSON.stringify({ tolerance: 0.25 }),
    })
    expect(bodies[0].parameters[0]).toContain("--tolerance 0.25")

    const bad = await app.request("/api/admin/jobs/price-audit/run", {
      method: "POST", headers: authed, body: JSON.stringify({ tolerance: 5 }),
    })
    expect(bad.status).toBe(422)
  })

  it("refuses a concurrent run with 409", async () => {
    mockJobshot({ status: { status: "Running", exists: true, isRunning: true } })
    const res = await app.request("/api/admin/jobs/price-audit/run", { method: "POST", headers: authed, body: "{}" })
    expect(res.status).toBe(409)
  })

  it("401s without an Authorization header — the job needs a caller identity", async () => {
    mockJobshot()
    const res = await app.request("/api/admin/jobs/price-audit/run", {
      method: "POST", headers: { ...adminHeaders, "Content-Type": "application/json" }, body: "{}",
    })
    expect(res.status).toBe(401)
  })

  it("exposes a status route", async () => {
    mockJobshot()
    const res = await app.request("/api/admin/jobs/price-audit/status", { headers: authed })
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty("status")
  })

  it("defaults the image to a pinned wallets release, never :latest", () => {
    // An unpinned image would let a wallets release change the audit under us.
    expect(walletsImage()).toMatch(/^ghcr\.io\/marx2\/portfoliost-wallets:v\d+\.\d+\.\d+$/)
  })
})

describe("buildPriceAuditSpec", () => {
  it("omits --tolerance when none is supplied, so the script's default stands", () => {
    const spec = buildPriceAuditSpec("tok")
    expect(spec.parameters[0]).not.toContain("--tolerance")
  })

  it("ignores a non-finite tolerance rather than writing NaN into the command", () => {
    expect(buildPriceAuditSpec("tok", Number.NaN).parameters[0]).not.toContain("--tolerance")
  })
})
