import { Hono } from "hono"
import { probeServiceMetas } from "./service-probe.js"
import { queryInstant, seriesMap } from "./prometheus.js"
import { loadTrafficData } from "./topology-traffic.js"
import { workloadTargets, type WorkloadTarget } from "./workload-probe.js"
import type { components } from "./generated/api-types"

type TopologyServiceStatus = components["schemas"]["TopologyServiceStatus"]
type TopologyStatusResponse = components["schemas"]["TopologyStatusResponse"]

interface DeploymentHealth {
  desired: number
  ready: number
  restarts: number
}

function namespace(): string {
  return process.env.K8S_NAMESPACE ?? "pfire"
}

// Per-deployment replica counts + restart counts backed by kube-state-metrics.
// Restarts are attributed to their owning deployment via the pod→replica-set
// →deployment owner chain.
async function loadDeploymentHealth(): Promise<Map<string, DeploymentHealth>> {
  const ns = namespace()
  const [desiredSeries, readySeries, restartSeries] = await Promise.all([
    queryInstant(`kube_deployment_status_replicas{namespace="${ns}"}`),
    queryInstant(`kube_deployment_status_replicas_ready{namespace="${ns}"}`),
    queryInstant(
      `sum by (owner_name) (` +
        `kube_pod_container_status_restarts_total{namespace="${ns}"}` +
        ` * on (pod) group_left(replicaset) ` +
        `label_replace(kube_pod_info{namespace="${ns}"}, "replicaset", "$1", "created_by_name", "(.+)")` +
        ` * on (replicaset) group_left(owner_name) ` +
        `kube_replicaset_owner{namespace="${ns}", owner_kind="Deployment"}` +
        `)`,
    ),
  ])

  const desired = seriesMap(desiredSeries, "deployment")
  const ready = seriesMap(readySeries, "deployment")
  const restarts = seriesMap(restartSeries, "owner_name")

  const out = new Map<string, DeploymentHealth>()
  for (const [name, desiredCount] of desired) {
    out.set(name, { desired: desiredCount, ready: ready.get(name) ?? 0, restarts: restarts.get(name) ?? 0 })
  }
  return out
}

// Image tag parsed from an image reference ("registry/repo:tag" → "tag").
// Returns null when the reference has no tag (or carries a digest instead).
export function parseImageTag(image: string): string | null {
  // strip digest, then look for a tag after the last "/"
  const noDigest = image.split("@")[0]
  const lastSlash = noDigest.lastIndexOf("/")
  const last = noDigest.slice(lastSlash + 1)
  const idx = last.indexOf(":")
  return idx > 0 ? last.slice(idx + 1) : null
}

// k8s-only workload health (postgres/redis): replica counts from
// kube-state-metrics, restarts, version from the image tag on
// kube_pod_container_info. Deployment-kind workloads (redis) reuse the
// existing deployment health map (owner-chain restarts); statefulset workloads
// (postgres) query kube_statefulset_* + a created_by_name restart attribution
// (for STS pods created_by_name is the StatefulSet name).
// Degrades per target: any failed query nulls that row's fields, never 500s.
async function loadWorkloadStatusRow(
  t: WorkloadTarget,
  health: Map<string, DeploymentHealth> | null,
): Promise<TopologyServiceStatus> {
  const ns = namespace()
  const base: TopologyServiceStatus = {
    name: t.id,
    reachable: false,
    impl: "real",
    replicas: null,
    restarts: null,
  }

  try {
    if (t.kind === "deployment") {
      const h = health?.get(t.name ?? "")
      if (h) {
        base.reachable = h.ready >= h.desired
        base.replicas = { desired: h.desired, ready: h.ready }
        base.restarts = h.restarts
      }
    } else {
      const [replicasSeries, readySeries, restartSeries] = await Promise.all([
        queryInstant(`kube_statefulset_status_replicas{namespace="${ns}", statefulset="${t.sts}"}`),
        queryInstant(`kube_statefulset_status_replicas_ready{namespace="${ns}", statefulset="${t.sts}"}`),
        queryInstant(
          `sum by (created_by_name) (kube_pod_container_status_restarts_total{namespace="${ns}", pod=~"${t.podRe}"})`,
        ),
      ])
      if (replicasSeries.length > 0) {
        const desired = Number.parseFloat(replicasSeries[0].value[1]) || 0
        const ready = readySeries.length > 0 ? Number.parseFloat(readySeries[0].value[1]) || 0 : 0
        base.reachable = ready >= desired
        base.replicas = { desired, ready }
      }
      const restart = restartSeries.find((s) => s.metric.created_by_name === t.sts)
      if (restart) base.restarts = Number.parseFloat(restart.value[1]) || 0
    }

    const imageSeries = await queryInstant(
      `kube_pod_container_info{namespace="${ns}", pod=~"${t.podRe}", container="${t.container}"}`,
    )
    const image = imageSeries.map((s) => s.metric.image).find(Boolean)
    const tag = image ? parseImageTag(image) : null
    if (tag) base.version = tag
  } catch (error) {
    console.error(`topology/status: workload ${t.id} query failed, degrading row:`, error)
  }

  return base
}

// D55-4 — topology live status: /__meta reachability fan-out overlaid with
// k8s deployment health (replicas, restarts) from Prometheus. Degrades to
// reachability-only (replicas/restarts null) when PROMETHEUS_URL is unset or
// any Prometheus query fails.
export function registerTopologyRoutes(admin: Hono) {
  admin.get("/topology/status", async (c) => {
    let health: Map<string, DeploymentHealth> | null = null
    if (process.env.PROMETHEUS_URL) {
      try {
        health = await loadDeploymentHealth()
      } catch (error) {
        console.error("topology/status: Prometheus unavailable, degrading to reachability-only:", error)
      }
    }

    const metas = await probeServiceMetas()
    const services: TopologyServiceStatus[] = metas.map((m) => {
      const h = health?.get(m.name)
      return {
        name: m.name,
        reachable: m.reachable,
        impl: m.impl,
        version: m.version,
        replicas: h ? { desired: h.desired, ready: h.ready } : null,
        restarts: h?.restarts ?? null,
      }
    })

    // k8s-only storage workloads (no /__meta endpoint) — one row per target,
    // degraded per target when a Prometheus query fails.
    const workloadRows = (process.env.PROMETHEUS_URL
      ? await Promise.all(workloadTargets().map((t) => loadWorkloadStatusRow(t, health)))
      : workloadTargets().map(
          (t) =>
            ({
              name: t.id,
              reachable: false,
              impl: "real" as const,
              replicas: null,
              restarts: null,
            }) satisfies TopologyServiceStatus,
        )).filter((row) => !services.some((s) => s.name === row.name))
    services.push(...workloadRows)

    const body: TopologyStatusResponse = { services, fetchedAt: new Date().toISOString() }
    return c.json(body)
  })

  // D55-4 — topology live traffic: per-service rate / error rate / P99, preferring
  // D56 OTel metrics with nginx-ingress fallback, plus cachest per-provider P99.
  admin.get("/topology/traffic", async (c) => {
    const body = await loadTrafficData()
    return c.json(body)
  })
}