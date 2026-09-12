import { queryInstant, seriesMap } from "./prometheus.js"
import { serviceTargets } from "./service-probe.js"
import type { components } from "./generated/api-types"

type TopologyServiceTraffic = components["schemas"]["TopologyServiceTraffic"]
type TopologyTrafficResponse = components["schemas"]["TopologyTrafficResponse"]

function namespace(): string {
  return process.env.K8S_NAMESPACE ?? "pfire"
}

// ── D56 (OpenTelemetry) server-side queries — preferred source when present ──
// Prometheus setups vary in which label carries the service identity:
// an OTLP->Prometheus collector best-efforts `service_name` (the OTel
// `service.name` resource attribute), a plain scrape job uses `job`, and a
// richer relabelling keeps the K8s `service` label. The exporter in the
// homelab cluster emits `job` (no `service_name`), so we probe the labels in
// preference order and stop at the first that yields series.
const LABEL_PREF: string[] = ["service_name", "job", "service"]

const OTEL_RATE_BASE = `rate(http_server_request_duration_seconds_count[5m])`
const OTEL_ERR_BASE = `rate(http_server_request_duration_seconds_count{http_response_status_code=~"4..|5.."}[5m])`
const OTEL_P99_BASE = (label: string) =>
  `histogram_quantile(0.99, sum by (le, ${label}) (rate(http_server_request_duration_seconds_bucket[5m])))`

// cachest outbound latency per upstream provider (D56-3: httpx instrumented,
// labelled by server_address, filtered to the cachest service itself).
const CACHEST_P99_Q =
  `histogram_quantile(0.99, sum by (le, server_address) (rate(http_client_request_duration_seconds_bucket{service_name="cachest"}[5m])))`

// ── nginx ingress controller fallback — used when D56 OTel metrics are absent ──
function ingressRateQ(): string {
  return `sum by (service) (rate(nginx_ingress_controller_requests{exported_namespace="${namespace()}"}[5m]))`
}
function ingressErrQ(): string {
  return `sum by (service) (rate(nginx_ingress_controller_requests{exported_namespace="${namespace()}", status=~"4..|5.."}[5m]))`
}
function ingressP99Q(): string {
  return `histogram_quantile(0.99, sum by (le, service) (rate(nginx_ingress_controller_request_duration_seconds_bucket{exported_namespace="${namespace()}"}[5m])))`
}

// nginx-gateway aggregate: the ingress controller exports per-host series
// (host label = virtual host). Point INGRESS_APP_HOST at the SPA's public host
// (e.g. "portfoliost.k.homylab.com") to give the gateway node a traffic box.
function ingressGatewayHost(): string {
  return process.env.INGRESS_APP_HOST ?? ""
}
function gatewayRateQ(): string {
  return `sum by (host) (rate(nginx_ingress_controller_requests{host="${ingressGatewayHost()}"}[5m]))`
}
function gatewayErrQ(): string {
  return `sum by (host) (rate(nginx_ingress_controller_requests{host="${ingressGatewayHost()}", status=~"4..|5.."}[5m]))`
}
function gatewayP99Q(): string {
  return `histogram_quantile(0.99, sum by (le, host) (rate(nginx_ingress_controller_request_duration_seconds_bucket{host="${ingressGatewayHost()}"}[5m])))`
}

const EMPTY_RESULT: QueryResult = { map: new Map<string, number>(), ok: false }

function gatewayResults(): Promise<QueryResult>[] {
  return ingressGatewayHost()
    ? [queryMap(gatewayRateQ(), "host"), queryMap(gatewayErrQ(), "host"), queryMap(gatewayP99Q(), "host")]
    : [Promise.resolve(EMPTY_RESULT), Promise.resolve(EMPTY_RESULT), Promise.resolve(EMPTY_RESULT)]
}

interface QueryResult {
  map: Map<string, number>
  ok: boolean
}

// Run one instant query and index the result by a label. Never throws — a
// Prometheus failure yields an empty map (ok: false) so the endpoint degrades.
async function queryMap(query: string, label: string): Promise<QueryResult> {
  try {
    const series = await queryInstant(query)
    return { map: seriesMap(series, label), ok: true }
  } catch (error) {
    console.error("topology/traffic: Prometheus query failed:", error)
    return { map: new Map<string, number>(), ok: false }
  }
}

// Run `sum by (<label>) (<base>)` for each label in preference order and return
// the first label that yields any series. Labels that exist on the exported
// series produce results; the first with data wins (service_name → job →
// service), so OTLP setups and plain scrape jobs both resolve.
async function queryMapByLabel(baseQuery: string): Promise<QueryResult> {
  for (const label of LABEL_PREF) {
    const res = await queryMap(`sum by (${label}) (${baseQuery})`, label)
    if (res.ok && res.map.size > 0) return res
  }
  return { map: new Map<string, number>(), ok: false }
}

// Histogram quantile queries group by `le` plus the identity label, so the
// preference order is resolved at the query level instead of in code.
async function queryP99ByLabel(baseQuery: (label: string) => string): Promise<QueryResult> {
  for (const label of LABEL_PREF) {
    const res = await queryMap(baseQuery(label), label)
    if (res.ok && res.map.size > 0) return res
  }
  return { map: new Map<string, number>(), ok: false }
}

function round(x: number, digits = 0): number {
  const f = 10 ** digits
  return Math.round(x * f) / f
}

function buildService(
  name: string,
  source: TopologyServiceTraffic["source"],
  total: number,
  errors: number,
  p99Seconds: number,
): TopologyServiceTraffic {
  return {
    name,
    requestsPerMin: round(total * 60, 2),
    errorRate: total > 0 ? round(errors / total, 4) : 0,
    p99LatencyMs: round(p99Seconds * 1000),
    source,
  }
}

// D55-4 — topology traffic: per-service request rate / error rate / P99 latency,
// preferring D56 OTel http server metrics and falling back to nginx-ingress
// controller metrics per service. Also returns cachest per-upstream-provider P99
// and, when INGRESS_APP_HOST is configured, an aggregate for the nginx-gateway
// node (per-host ingress volume = what the gateway actually serves).
// Degrades to an empty payload when Prometheus is unavailable.
export async function loadTrafficData(): Promise<TopologyTrafficResponse> {
  const fetchedAt = new Date().toISOString()
  if (!process.env.PROMETHEUS_URL) {
    return { services: [], cachestProviders: [], fetchedAt }
  }

  const gatewayConfigured = Boolean(ingressGatewayHost())
  const [otelRate, otelErr, otelP99, cachestP99, ingRate, ingErr, ingP99, gwRate, gwErr, gwP99] = await Promise.all([
    queryMapByLabel(OTEL_RATE_BASE),
    queryMapByLabel(OTEL_ERR_BASE),
    queryP99ByLabel(OTEL_P99_BASE),
    queryMap(CACHEST_P99_Q, "server_address"),
    queryMap(ingressRateQ(), "service"),
    queryMap(ingressErrQ(), "service"),
    queryMap(ingressP99Q(), "service"),
    ...gatewayResults(),
  ])

  const anyOk = [otelRate, otelErr, otelP99, cachestP99, ingRate, ingErr, ingP99, gwRate, gwErr, gwP99].some((r) => r.ok)
  if (!anyOk) {
    return { services: [], cachestProviders: [], fetchedAt }
  }

  const services: TopologyServiceTraffic[] = serviceTargets().map((t) => {
    const name = t.name
    if (otelRate.map.has(name) || otelErr.map.has(name) || otelP99.map.has(name)) {
      return buildService(name, "otel", otelRate.map.get(name) ?? 0, otelErr.map.get(name) ?? 0, otelP99.map.get(name) ?? 0)
    }
    if (ingRate.map.has(name) || ingErr.map.has(name) || ingP99.map.has(name)) {
      return buildService(name, "ingress", ingRate.map.get(name) ?? 0, ingErr.map.get(name) ?? 0, ingP99.map.get(name) ?? 0)
    }
    return buildService(name, "none", 0, 0, 0)
  })

  if (gatewayConfigured) {
    const host = ingressGatewayHost()
    const hasData = gwRate.map.has(host) || gwErr.map.has(host) || gwP99.map.has(host)
    services.push(
      buildService(
        "nginx-gateway",
        hasData ? "ingress" : "none",
        gwRate.map.get(host) ?? 0,
        gwErr.map.get(host) ?? 0,
        gwP99.map.get(host) ?? 0,
      ),
    )
  }

  const cachestProviders = [...cachestP99.map.entries()].map(([provider, seconds]) => ({
    provider,
    p99LatencyMs: round(seconds * 1000),
  }))

  return { services, cachestProviders, fetchedAt }
}