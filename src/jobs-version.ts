import { KubeConfig, BatchV1Api, AppsV1Api } from "@kubernetes/client-node"

export interface JobVersion {
  name: string
  version: string
  impl: "job"
}

export interface DeploymentImage {
  name: string
  image: string
}

const NAMESPACE = process.env.K8S_NAMESPACE ?? "pfire"

// Job containers that are part of the portfoliost set but run on their own
// schedule (CronJobs or a long-running runner) rather than as API services.
// Their "version" is the image ref currently pinned by Flux.
const CRONJOBS = [
  "portfoliost-wallets-fxsync",
  "portfoliost-instruments-tickersync",
  "stooq-downloader",
  "stooq-importer",
]

// API service deployments in the portfoliost set (long-running pods behind
// the ingress). Read so the System tab can show the full image ref next to
// the /__meta version, matching the job entries.
const SERVICE_DEPLOYMENTS = [
  "portfoliost-admin",
  "portfoliost-users-auth",
  "portfoliost-wallets",
  "portfoliost-instruments",
  "openst",
  "cachest",
]

async function listDeployments(): Promise<Map<string, string>> {
  const kc = new KubeConfig()
  kc.loadFromCluster()
  const apps = kc.makeApiClient(AppsV1Api)
  const list = await apps.listNamespacedDeployment({ namespace: NAMESPACE })
  const map = new Map<string, string>()
  for (const d of list.items) {
    const image = d.spec?.template?.spec?.containers?.[0]?.image
    if (image) map.set(d.metadata?.name ?? "", image)
  }
  return map
}

export async function listServiceImages(): Promise<DeploymentImage[]> {
  if (!process.env.KUBERNETES_SERVICE_HOST) {
    return [] // not running in-cluster (local dev / unit tests)
  }
  try {
    const byName = await listDeployments()
    return SERVICE_DEPLOYMENTS.filter((n) => byName.has(n)).map((n) => ({ name: n, image: byName.get(n)! }))
  } catch {
    return [] // no RBAC for deployments -> images degrade silently
  }
}

export async function listJobVersions(): Promise<JobVersion[]> {
  if (!process.env.KUBERNETES_SERVICE_HOST) {
    return [] // not running in-cluster (local dev / unit tests)
  }

  const kc = new KubeConfig()
  kc.loadFromCluster()

  const batch = kc.makeApiClient(BatchV1Api)

  const results: JobVersion[] = []

  try {
    const list = await batch.listNamespacedCronJob({ namespace: NAMESPACE })
    const byName = new Map(list.items.map((cj) => [cj.metadata?.name, cj]))
    for (const name of CRONJOBS) {
      const rows = byName.get(name)?.spec?.jobTemplate?.spec?.template?.spec?.containers
      const image = rows?.[0]?.image
      if (image) results.push({ name, version: image, impl: "job" })
    }
  } catch {
    // no RBAC for cronjobs -> jobs section simply degrades
  }

  try {
    const deploy = await kc.makeApiClient(AppsV1Api).readNamespacedDeployment({ name: "jobshot", namespace: NAMESPACE })
    const image = deploy.spec?.template?.spec?.containers?.[0]?.image
    if (image) results.push({ name: "jobshot", version: image, impl: "job" })
  } catch {
    // no RBAC for deployments -> degrade silently
  }

  return results
}