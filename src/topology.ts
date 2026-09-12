import { Hono } from "hono"
import { probeServiceMetas } from "./service-probe.js"
import { queryInstant, seriesMap } from "./prometheus.js"
import { loadTrafficData } from "./topology-traffic.js"
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