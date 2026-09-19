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
  "INGRESS_APP_HOST",
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
      // A marker matches when its kind prefix appears in the query — e.g.
      // "kube_deployment_status_replicas{" matches the deployment desired query
      // but not the statefulset variant, "kube_pod_container_info" matches only
      // the version-image query.
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
      // 6 HTTP-probed services + 2 k8s-only storage workloads (no /__meta)
      expect(new Set(services.map((s) => s.name))).toEqual(
        new Set([
          "portfoliost-admin", "portfoliost-users-auth", "portfoliost-wallets", "portfoliost-instruments", "openst", "cachest", "postgres", "redis",
        ]),
      )
      for (const s of services) {
        if (["postgres", "redis"].includes(s.name as string)) {
          // storage workloads: impl real, unreachable without a live cluster, null replicas/restarts
          expect(s.impl).toBe("real")
          expect(s.reachable).toBe(false)
          expect(s.replicas).toBeNull()
          expect(s.restarts).toBeNull()
          continue
        }
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
      // 6 HTTP-probed services + 2 storage workloads
      expect(services.length).toBe(8)
      for (const s of services) {
        if (["postgres", "redis"].includes(s.name as string)) {
          // storage workloads keep their row regardless of /__meta reachability
          expect(s.impl).toBe("real")
          continue
        }
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
          // redis deployment (k8s-only workload branch)
          { metric: { deployment: "redis" }, value: [1, "1"] },
        ],
        // ready
        "kube_deployment_status_replicas_ready{": [
          series("portfoliost-admin", "1"),
          series("openst", "0"),
          { metric: { deployment: "redis" }, value: [1, "1"] },
        ],
        // StatefulSet replica counts (postgres k8s-only workload branch)
        "kube_statefulset_status_replicas{": [{ metric: { statefulset: "postgres-pfire-postgres-pfire-k8db" }, value: [1, "1"] }],
        "kube_statefulset_status_replicas_ready{": [{ metric: { statefulset: "postgres-pfire-postgres-pfire-k8db" }, value: [1, "1"] }],
        // restarts — deployment owner-chain join (result label is owner_name)
        "kube_replicaset_owner": [
          { metric: { owner_name: "portfoliost-admin" }, value: [1, "2"] },
          { metric: { owner_name: "openst" }, value: [1, "0"] },
          { metric: { owner_name: "redis" }, value: [1, "3"] },
        ],
        // restarts — STS attribution (created_by_name = StatefulSet name)
        'kube_pod_container_status_restarts_total{namespace="pfire", pod=~"^postgres-pfire-postgres-pfire-"}': [
          { metric: { created_by_name: "postgres-pfire-postgres-pfire-k8db" }, value: [1, "0"] },
        ],
        // image tag → version (markers scoped to the per-workload pod regex)
        'kube_pod_container_info{namespace="pfire", pod=~"^postgres-pfire-postgres-pfire-", container="database"}': [
          { metric: { image: "ghcr.io/postgres-operator/postgres:16.4-debian-12" }, value: [1, "1"] },
        ],
        'kube_pod_container_info{namespace="pfire", pod=~"^redis-", container="redis"}': [
          { metric: { image: "redis:7.4" }, value: [1, "1"] },
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

      // k8s-only storage workloads merged in: STS branch (postgres) + deployment branch (redis)
      const postgres = services.find((s) => s.name === "postgres")!
      expect(postgres.reachable).toBe(true)
      expect(postgres.impl).toBe("real")
      expect(postgres.replicas).toEqual({ desired: 1, ready: 1 })
      expect(postgres.restarts).toBe(0)
      expect(postgres.version).toBe("16.4-debian-12")

      const redis = services.find((s) => s.name === "redis")!
      expect(redis.reachable).toBe(true)
      expect(redis.impl).toBe("real")
      expect(redis.replicas).toEqual({ desired: 1, ready: 1 })
      expect(redis.restarts).toBe(3)
      expect(redis.version).toBe("7.4")
    } finally {
      orig.restore()
    }
  })

  it("marks a workload unreachable when ready < desired", async () => {
    setServiceEnv()
    process.env.PROMETHEUS_URL = "http://prom.example:9090"
    process.env.K8S_NAMESPACE = "pfire"
    const orig = mockFetch(
      { service: "svc", impl: "real", version: "1.2.3" },
      {
        "kube_statefulset_status_replicas{": [{ metric: { statefulset: "postgres-pfire-postgres-pfire-k8db" }, value: [1, "1"] }],
        "kube_statefulset_status_replicas_ready{": [{ metric: { statefulset: "postgres-pfire-postgres-pfire-k8db" }, value: [1, "0"] }],
      },
    )
    try {
      const res = await app.request("/api/admin/topology/status", { headers: adminHeaders })
      const body = await res.json()
      const services = body.services as Array<Record<string, any>>
      const postgres = services.find((s) => s.name === "postgres")!
      expect(postgres.reachable).toBe(false)
      expect(postgres.replicas).toEqual({ desired: 1, ready: 0 })
      // redis has no series at all → reachable false, null replicas (0 >= 0 guard aside, no data → degraded)
      const redis = services.find((s) => s.name === "redis")!
      expect(redis.reachable).toBe(false)
    } finally {
      orig.restore()
    }
  })

  it("degrades a workload row to nulls when its Prometheus queries fail, without 500ing", async () => {
    setServiceEnv()
    process.env.PROMETHEUS_URL = "http://prom.example:9090"
    process.env.K8S_NAMESPACE = "pfire"
    const orig = mockFetch(
      { service: "svc", impl: "real", version: "1.2.3" },
      {
        // deployment queries (incl. redis) answer fine
        "kube_deployment_status_replicas{": [{ metric: { deployment: "redis" }, value: [1, "1"] }],
        "kube_deployment_status_replicas_ready{": [{ metric: { deployment: "redis" }, value: [1, "1"] }],
        // all postgres (statefulset) queries fail → that row degrades
      },
    )
    // wrap to 500 the statefulset queries only
    const inner = globalThis.fetch as unknown as (input: RequestInfo | URL) => Promise<Response>
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const query = url.includes("/api/v1/query") ? new URL(url).searchParams.get("query") ?? "" : ""
      if (query.includes("kube_statefulset")) return new Response("boom", { status: 500 })
      return inner(input)
    }) as typeof fetch
    try {
      const res = await app.request("/api/admin/topology/status", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      const services = body.services as Array<Record<string, any>>
      const postgres = services.find((s) => s.name === "postgres")!
      expect(postgres.reachable).toBe(false)
      expect(postgres.replicas).toBeNull()
      expect(postgres.restarts).toBeNull()
      expect(postgres.version).toBeUndefined()
      // redis unaffected
      const redis = services.find((s) => s.name === "redis")!
      expect(redis.reachable).toBe(true)
      expect(redis.replicas).toEqual({ desired: 1, ready: 1 })
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

describe("GET /api/admin/topology/traffic (D55)", () => {
  it("returns empty payload when PROMETHEUS_URL is not set (local-dev fallback)", async () => {
    setServiceEnv()
    delete process.env.PROMETHEUS_URL
    const orig = mockFetch({ service: "svc", impl: "real", version: "1.2.3" })
    try {
      const res = await app.request("/api/admin/topology/traffic", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.services).toEqual([])
      expect(body.cachestProviders).toEqual([])
      expect(typeof body.fetchedAt).toBe("string")
    } finally {
      orig.restore()
    }
  })

  it("returns empty payload when Prometheus is down", async () => {
    setServiceEnv()
    process.env.PROMETHEUS_URL = "http://prom.example:9090"
    const orig = mockFetch({ service: "svc", impl: "real", version: "1.2.3" }, {}, 500)
    try {
      const res = await app.request("/api/admin/topology/traffic", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.services).toEqual([])
      expect(body.cachestProviders).toEqual([])
    } finally {
      orig.restore()
    }
  })

  it("uses the OTel path and populates cachestProviders when D56 metrics are present", async () => {
    setServiceEnv()
    process.env.PROMETHEUS_URL = "http://prom.example:9090"
    process.env.K8S_NAMESPACE = "pfire"
    const orig = mockFetch(
      { service: "svc", impl: "real", version: "1.2.3" },
      {
        // OTel server rate (no status filter) — rate query ends in _count[5m])
        "http_server_request_duration_seconds_count[5m])": [
          { metric: { service_name: "portfoliost-admin" }, value: [1, "0.5"] }, // 0.5/s → 30/min
          { metric: { service_name: "cachest" }, value: [1, "0.2"] },
        ],
        // OTel server error rate (only series carrying the status filter)
        "http_response_status_code": [
          { metric: { service_name: "portfoliost-admin" }, value: [1, "0.1"] }, // 0.1/0.5 = 0.2
        ],
        // OTel server P99
        "http_server_request_duration_seconds_bucket": [
          { metric: { service_name: "portfoliost-admin" }, value: [1, "0.25"] }, // 250 ms
        ],
        // cachest client P99 per upstream provider
        "http_client_request_duration_seconds_bucket": [
          { metric: { server_address: "openst" }, value: [1, "0.1"] }, // 100 ms
          { metric: { server_address: "alphavantage.co" }, value: [1, "0.4"] }, // 400 ms
        ],
      },
    )
    try {
      const res = await app.request("/api/admin/topology/traffic", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      const services = body.services as Array<Record<string, any>>
      expect(services.length).toBe(6)

      const admin = services.find((s) => s.name === "portfoliost-admin")!
      expect(admin.source).toBe("otel")
      expect(admin.requestsPerMin).toBe(30)
      expect(admin.errorRate).toBeCloseTo(0.2)
      expect(admin.p99LatencyMs).toBe(250)

      const cachest = services.find((s) => s.name === "cachest")!
      expect(cachest.source).toBe("otel")
      expect(cachest.requestsPerMin).toBe(12) // 0.2*60

      // no OTel data, no ingress data → none
      const wallets = services.find((s) => s.name === "portfoliost-wallets")!
      expect(wallets.source).toBe("none")
      expect(wallets.requestsPerMin).toBe(0)

      // cachestProviders populated from the per-server_address histogram
      expect(body.cachestProviders).toEqual(
        expect.arrayContaining([
          { provider: "openst", p99LatencyMs: 100 },
          { provider: "alphavantage.co", p99LatencyMs: 400 },
        ]),
      )
      expect(body.cachestProviders.length).toBe(2)
    } finally {
      orig.restore()
    }
  })

  it("falls back to nginx-ingress metrics when D56 OTel metrics are absent", async () => {
    setServiceEnv()
    process.env.PROMETHEUS_URL = "http://prom.example:9090"
    process.env.K8S_NAMESPACE = "pfire"
    const orig = mockFetch(
      { service: "svc", impl: "real", version: "1.2.3" },
      {
        // ingress rate — only series whose matcher has the namespace then closes with }[5m]
        'nginx_ingress_controller_requests{exported_namespace="pfire"}[5m]': [
          { metric: { service: "portfoliost-wallets" }, value: [1, "1"] }, // 1/s → 60/min
          { metric: { service: "portfoliost-admin" }, value: [1, "0.5"] },
        ],
        // ingress error rate — matcher carries the status filter
        'nginx_ingress_controller_requests{exported_namespace="pfire", status': [
          { metric: { service: "portfoliost-wallets" }, value: [1, "0.3"] }, // 0.3/1 = 0.3
        ],
        // ingress P99
        "nginx_ingress_controller_request_duration_seconds_bucket": [
          { metric: { service: "portfoliost-wallets" }, value: [1, "0.5"] }, // 500 ms
        ],
      },
    )
    try {
      const res = await app.request("/api/admin/topology/traffic", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      const services = body.services as Array<Record<string, any>>
      expect(services.length).toBe(6)

      const wallets = services.find((s) => s.name === "portfoliost-wallets")!
      expect(wallets.source).toBe("ingress")
      expect(wallets.requestsPerMin).toBe(60)
      expect(wallets.errorRate).toBeCloseTo(0.3)
      expect(wallets.p99LatencyMs).toBe(500)

      const admin = services.find((s) => s.name === "portfoliost-admin")!
      expect(admin.source).toBe("ingress")
      expect(admin.requestsPerMin).toBe(30)

      // OTel client histogram absent → no providers
      expect(body.cachestProviders).toEqual([])
    } finally {
      orig.restore()
    }
  })

  it("resolves OTel metrics via the job label when service_name is absent", async () => {
    // The homelab cluster exporter emits `job` (matching the node id), not the
    // OTel `service_name` resource attribute → the service_name query is empty
    // and the label-preference probe falls back to `job`.
    setServiceEnv()
    process.env.PROMETHEUS_URL = "http://prom.example:9090"
    const orig = mockFetch(
      { service: "svc", impl: "real", version: "1.2.3" },
      {
        "http_server_request_duration_seconds_count[5m])": [
          { metric: { job: "portfoliost-admin" }, value: [1, "0.5"] }, // 0.5/s → 30/min
          { metric: { job: "cachest" }, value: [1, "0.2"] },
        ],
        "http_response_status_code": [{ metric: { job: "portfoliost-admin" }, value: [1, "0.1"] }], // 0.2 error rate
        "http_server_request_duration_seconds_bucket": [{ metric: { job: "portfoliost-admin" }, value: [1, "0.25"] }], // 250 ms
      },
    )
    try {
      const res = await app.request("/api/admin/topology/traffic", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      const services = body.services as Array<Record<string, any>>
      expect(services.length).toBe(6)

      const admin = services.find((s) => s.name === "portfoliost-admin")!
      expect(admin.source).toBe("otel")
      expect(admin.requestsPerMin).toBe(30)
      expect(admin.errorRate).toBeCloseTo(0.2)
      expect(admin.p99LatencyMs).toBe(250)

      const cachest = services.find((s) => s.name === "cachest")!
      expect(cachest.source).toBe("otel")
      expect(cachest.requestsPerMin).toBe(12)

      expect(body.cachestProviders).toEqual([])
    } finally {
      orig.restore()
    }
  })

  it("appends the nginx-gateway aggregate when INGRESS_APP_HOST is set", async () => {
    setServiceEnv()
    process.env.PROMETHEUS_URL = "http://prom.example:9090"
    process.env.INGRESS_APP_HOST = "portfoliost.example.com"
    const orig = mockFetch(
      { service: "svc", impl: "real", version: "1.2.3" },
      {
        // gateway rate — 0.2/s on the app host → 12/min
        '{host="portfoliost.example.com"}[5m]': [{ metric: { host: "portfoliost.example.com" }, value: [1, "0.2"] }],
        // gateway error rate
        '{host="portfoliost.example.com", status=~"4..|5.."}': [{ metric: { host: "portfoliost.example.com" }, value: [1, "0.05"] }],
        // gateway P99
        "nginx_ingress_controller_request_duration_seconds_bucket": [{ metric: { host: "portfoliost.example.com" }, value: [1, "0.3"] }],
      },
    )
    try {
      const res = await app.request("/api/admin/topology/traffic", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      const services = body.services as Array<Record<string, any>>
      // 6 probed services + the gateway aggregate
      expect(services.length).toBe(7)

      const gateway = services.find((s) => s.name === "nginx-gateway")!
      expect(gateway.source).toBe("ingress")
      expect(gateway.requestsPerMin).toBe(12)
      expect(gateway.errorRate).toBeCloseTo(0.25)
      expect(gateway.p99LatencyMs).toBe(300)

      // the probed services have no OTel/ingress-per-service series → none
      const admin = services.find((s) => s.name === "portfoliost-admin")!
      expect(admin.source).toBe("none")
      expect(admin.requestsPerMin).toBe(0)
    } finally {
      orig.restore()
    }
  })
})