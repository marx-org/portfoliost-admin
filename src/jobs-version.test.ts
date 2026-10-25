import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { KubeConfig, BatchV1Api, AppsV1Api } from "@kubernetes/client-node"

const listNamespacedCronJob = vi.fn(async () => ({ items: [] as unknown[] }))
const readNamespacedDeployment = vi.fn(async () => {
  throw new Error("no jobshot")
})

vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: class {
    loadFromCluster() {}
    makeApiClient(api: unknown) {
      return api === BatchV1Api ? { listNamespacedCronJob } : { readNamespacedDeployment }
    }
  },
  BatchV1Api: class {},
  AppsV1Api: class {},
}))

function cronJob(name: string, schedule: string, suspend = false, image = "ghcr.io/marx2/x:v1.0.0") {
  return {
    metadata: { name },
    spec: {
      schedule,
      suspend,
      jobTemplate: { spec: { template: { spec: { containers: [{ image }] } } } },
    },
  }
}

async function load() {
  return import("./jobs-version.js")
}

beforeEach(() => {
  process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1"
  listNamespacedCronJob.mockReset()
  listNamespacedCronJob.mockResolvedValue({ items: [] })
  readNamespacedDeployment.mockReset()
  readNamespacedDeployment.mockRejectedValue(new Error("no jobshot"))
})

afterEach(() => {
  delete process.env.KUBERNETES_SERVICE_HOST
  vi.resetModules()
})

describe("CRONJOBS (§80.1)", () => {
  it("lists the twelve portfoliost-owned CronJobs of the pfire namespace", async () => {
    const { CRONJOBS } = await load()
    expect(CRONJOBS).toEqual([
      "portfoliost-instruments-tickersync",
      "portfoliost-instruments-fxsync",
      "portfoliost-instruments-corpbondsync",
      "portfoliost-instruments-fundcategorysync",
      "portfoliost-instruments-splitsync",
      "portfoliost-wallets-snapshotsync",
      "openst-bond-import",
      "openst-bond-archive",
      "openst-cpi-import",
      "openst-cpi-seed",
      "stooq-downloader",
      "stooq-importer",
    ])
  })

  it("holds no name that the cluster does not run — the drift that hid the dead fxsync row", async () => {
    const { CRONJOBS } = await load()
    expect(CRONJOBS).not.toContain("portfoliost-wallets-fxsync")
    expect(CRONJOBS).not.toContain("portfoliost-wallets-snapshotsync-postfx")
    // Shared-namespace tenants stay out: the ownership line is the homelab
    // manifests, not `kubectl get cronjobs` (§80 preamble).
    for (const foreign of ["pgdb", "stooq", "scanst", "scanst-override", "scanst-test"]) {
      expect(CRONJOBS).not.toContain(foreign)
      expect(CRONJOBS).not.toContain(`postgres-pfire-repo1-${foreign}`)
    }
  })
})

describe("listJobVersions", () => {
  it("returns one row per name that exists, carrying the declared schedule", async () => {
    listNamespacedCronJob.mockResolvedValue({
      items: [
        cronJob("portfoliost-instruments-fxsync", "10 17 * * *", false, "ghcr.io/marx2/portfoliost-instruments:v1.0.91"),
        cronJob("portfoliost-instruments-tickersync", "30 4 * * 1", false, "ghcr.io/marx2/portfoliost-instruments:v1.0.91"),
      ],
    })
    const { listJobVersions } = await load()
    const rows = await listJobVersions()
    // rows follow CRONJOBS order, not the cluster's
    expect(rows.map((r) => r.name)).toEqual([
      "portfoliost-instruments-tickersync",
      "portfoliost-instruments-fxsync",
    ])
    expect(rows.find((r) => r.name === "portfoliost-instruments-fxsync")).toEqual({
      name: "portfoliost-instruments-fxsync",
      version: "ghcr.io/marx2/portfoliost-instruments:v1.0.91",
      impl: "job",
      schedule: "10 17 * * *",
    })
  })

  it("skips a name that is absent from the cluster — correct, and why this list needs a guard", async () => {
    listNamespacedCronJob.mockResolvedValue({
      items: [cronJob("portfoliost-instruments-fxsync", "10 17 * * *")],
    })
    const { listJobVersions } = await load()
    const rows = await listJobVersions()
    expect(rows.map((r) => r.name)).toEqual(["portfoliost-instruments-fxsync"])
  })

  it("never invents a name the cluster does not hold", async () => {
    listNamespacedCronJob.mockResolvedValue({
      items: [cronJob("pgdb", "@yearly"), cronJob("postgres-pfire-repo1-full", "0 1 * * 0")],
    })
    const { listJobVersions } = await load()
    expect(await listJobVersions()).toEqual([])
  })

  it("reports a suspended CronJob as suspended", async () => {
    listNamespacedCronJob.mockResolvedValue({
      items: [
        cronJob("openst-cpi-seed", "0 5 1 1 *", true, "ghcr.io/marx2/openst:v1.1.44"),
        cronJob("stooq-importer", "@yearly", false, "dimitri/pgloader:ccl.latest"),
      ],
    })
    const { listJobVersions } = await load()
    const rows = await listJobVersions()
    expect(rows[0]).toMatchObject({ name: "openst-cpi-seed", schedule: "0 5 1 1 *", suspended: true })
    // An unsuspended job carries no `suspended` key at all — the SPA renders
    // "Scheduled", and an explicit `false` would be the same thing said twice.
    expect(rows[1].suspended).toBeUndefined()
  })

  it("reports jobshot as a service rather than a scheduled job", async () => {
    readNamespacedDeployment.mockResolvedValue({
      spec: { template: { spec: { containers: [{ image: "ghcr.io/marx2/jobshot:v1.6.1" }] } } },
    } as never)

    const { listJobVersions } = await load()
    expect(await listJobVersions()).toEqual([
      { name: "jobshot", version: "ghcr.io/marx2/jobshot:v1.6.1", impl: "real" },
    ])
  })

  it("returns nothing outside a cluster", async () => {
    delete process.env.KUBERNETES_SERVICE_HOST
    const { listJobVersions } = await load()
    expect(await listJobVersions()).toEqual([])
  })

  it("degrades to no cronjob rows when RBAC denies the list", async () => {
    listNamespacedCronJob.mockRejectedValue(new Error("forbidden"))
    const { listJobVersions } = await load()
    expect(await listJobVersions()).toEqual([])
  })
})
