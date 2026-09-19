// Workload targets for the topology map: storage nodes (postgres, redis) have
// no /__meta endpoint, so their health comes straight from Kubernetes
// (kube-state-metrics + cAdvisor) instead of an HTTP probe. Names follow the
// homelab cluster layout (postgres-pfire Crunchy PostgresCluster, redis deployment).

export interface WorkloadTarget {
  id: string
  kind: "statefulset" | "deployment"
  /** StatefulSet name (kind === "statefulset") */
  sts?: string
  /** Deployment name (kind === "deployment") */
  name?: string
  /** Pod name regex for cAdvisor / kube_pod_container_info */
  podRe: string
  /** Container name inside the pod (for image tag + resource metrics) */
  container: string
}

/**
 * Storage workload targets for the topology map.
 *
 * - postgres: Crunchy PostgresCluster `postgres-pfire` → StatefulSet
 *   `postgres-pfire-postgres-pfire-k8db`, pods `postgres-pfire-postgres-pfire-…`,
 *   container `database`. Overridable via TOPOLOGY_POSTGRES_STATEFULSET.
 * - redis: deployment `redis` (REDIS_HOST per cachest helmrelease), container `main`.
 */
export function workloadTargets(): WorkloadTarget[] {
  return [
    {
      id: "postgres",
      kind: "statefulset",
      sts: process.env.TOPOLOGY_POSTGRES_STATEFULSET ?? "postgres-pfire-postgres-pfire-k8db",
      podRe: "^postgres-pfire-postgres-pfire-",
      container: "database",
    },
    {
      id: "redis",
      kind: "deployment",
      name: "redis",
      podRe: "^redis-",
      container: "main",
    },
  ]
}
