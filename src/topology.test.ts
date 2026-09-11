import { describe, it, expect, afterEach } from "vitest"
import app from "./index.js"

const adminHeaders = {
  "X-User-Id": "admin-1",
  "X-User-Email": "admin@example.com",
  "X-User-Groups": "portfoliost_admin",
}

const ENV_KEYS = [
  "API_USERS_AUTH_URL",
  "API_WALLETS_URL",
  "API_INSTRUMENTS_URL",
  "API_OPENST_URL",
  "API_CACHEST_URL",
  "PROMETHEUS_URL",
  "K8S_NAMESPACE",
] as const

function setServiceEnv() {
  process.env.API_USERS_AUTH_URL = "http://users-auth:3000"
  process.env.API_WALLETS_URL = "http://wallets:3000"
  process.env.API_INSTRUMENTS_URL = "http://instruments:3000"
  process.env.API_OPENST_URL = "http://openst:8080"
  process.env.API_CACHEST_URL = "http://cachest:8080"
}

function clearServiceEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

afterEach(clearServiceEnv)

interface Series {
  metric: Record<string, string>
  value: [number, string]
}

function promResponse(series: Series[]) {
  return new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result: series } }), {
    headers: { "content-type": "application/json" },
  })
}

function series(deployment: string, value: string): Series {
  return { metric: { deployment }, value: [1, value] }
}

// mockFetch installs a fetch that answers /__meta probes and Prometheus
// instant queries. promBySubstring maps query-substring → series.
function mockFetch(
  meta: { service: string; impl: string; version: string },
  promBySubstring: Record<string, Series[]> = {},
  promStatus = 200,
) {
  const seenPromQueries: string[] = []
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("/__meta")) {
      return new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } })
    }
    if (url.startsWith("http://prom.example:9090/api/v1/query")) {
      const query = new URL(url).searchParams.get("query") ?? ""
      seenPromQueries.push(query)
      if (promStatus !== 200) return new Response("boom", { status: promStatus })
      const hits = Object.entries(promBySubstring)
        .filter(([marker]) => query.includes(marker))
        .flatMap(([, s]) => s)
      return promResponse(hits)
    }
    return new Response("Not Found", { status: 404 })
  }) as typeof fetch
  return { seenPromQueries, restore: () => (globalThis.fetch = origFetch) }
}

describe("GET /api/admin/topology/status (D55)", () => {
  it("rejects unauthenticated request with 401", async () => {
    const res = await app.request("/api/admin/topology/status")
    expect(res.status).toBe(401)
  })

  it("rejects non-admin group with 403", async () => {
    const res = await app.request("/api/admin/topology/status", {
      headers: { "X-User-Id": "user-1", "X-User-Email": "test@example.com", "X-User-Groups": "portfoliost_user" },
    })
    expect(res.status).toBe(403)
  })

  it("returns reachability-only data when PROMETHEUS_URL is not set (local-dev fallback)", async () => {
    setServiceEnv()
    delete process.env.PROMETHEUS_URL
    const orig = mockFetch({ service: "svc", impl: "real", version: "1.2.3" })
    try {
      const res = await app.request("/api/admin/topology/status", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      const services = body.services as Array<Record<string, unknown>>
      expect(new Set(services.map((s) => s.name))).toEqual(
        new Set(["portfoliost-admin", "portfoliost-users-auth", "portfoliost-wallets", "portfoliost-instruments", "openst", "cachest"]),
      )
      for (const s of services) {
        expect(s.reachable).toBe(true)
        expect(s.impl).toBe("real")
        expect(s.version).toBe("1.2.3")
        expect(s.replicas).toBeNull()
        expect(s.restarts).toBeNull()
      }
    } finally {
      orig.restore()
    }
  })

  it("marks unreachable services with impl unknown and reachable false", async () => {
    setServiceEnv()
    delete process.env.PROMETHEUS_URL
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch
    try {
      const res = await app.request("/api/admin/topology/status", { headers: adminHeaders })
      const body = await res.json()
      const services = body.services as Array<Record<string, unknown>>
      expect(services.length).toBe(6)
      for (const s of services) {
        expect(s.reachable).toBe(false)
        expect(s.impl).toBe("unknown")
        expect(s.version).toBe("unreachable")
      }
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it("overlays Prometheus replica counts and restart counts onto probe results", async () => {
    setServiceEnv()
    process.env.PROMETHEUS_URL = "http://prom.example:9090"
    process.env.K8S_NAMESPACE = "pfire"
    const orig = mockFetch(
      { service: "svc", impl: "real", version: "1.2.3" },
      {
        // desired — matches kube_deployment_status_replicas{...}
        "kube_deployment_status_replicas{": [
          series("portfoliost-admin", "1"),
          series("openst", "1"),
          series("portfoliost-users-auth", "1"),
        ],
        // ready
        "kube_deployment_status_replicas_ready{": [
          series("portfoliost-admin", "1"),
          series("openst", "0"),
        ],
        // restarts join — result label is owner_name (deployment name)
        "kube_pod_container_status_restarts_total": [
          { metric: { owner_name: "portfoliost-admin" }, value: [1, "2"] },
          { metric: { owner_name: "openst" }, value: [1, "0"] },
        ],
      },
    )
    try {
      const res = await app.request("/api/admin/topology/status", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      const services = body.services as Array<Record<string, any>>

      const admin = services.find((s) => s.name === "portfoliost-admin")!
      expect(admin.replicas).toEqual({ desired: 1, ready: 1 })
      expect(admin.restarts).toBe(2)

      const openst = services.find((s) => s.name === "openst")!
      expect(openst.replicas).toEqual({ desired: 1, ready: 0 })
      expect(openst.restarts).toBe(0)

      // cachest is probed but has no Deployment series → nulls
      const cachest = services.find((s) => s.name === "cachest")!
      expect(cachest.replicas).toBeNull()
      expect(cachest.restarts).toBeNull()

      // the restarts owner-chain join query was actually issued
      expect(orig.seenPromQueries.some((q) => q.includes("kube_replicaset_owner"))).toBe(true)
    } finally {
      orig.restore()
    }
  })

  it("degrades to null replicas/restarts when Prometheus errors", async () => {
    setServiceEnv()
    process.env.PROMETHEUS_URL = "http://prom.example:9090"
    const orig = mockFetch({ service: "svc", impl: "real", version: "1.2.3" }, {}, 500)
    try {
      const res = await app.request("/api/admin/topology/status", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      const services = body.services as Array<Record<string, unknown>>
      expect(services.length).toBeGreaterThan(0)
      for (const s of services) {
        expect(s.replicas).toBeNull()
        expect(s.restarts).toBeNull()
      }
    } finally {
      orig.restore()
    }
  })
})