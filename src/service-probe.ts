export interface ServiceTarget {
  name: string
  url: string
}

export interface ServiceMeta {
  name: string
  service: string
  version: string
  impl: "real" | "mock" | "unknown" | "job"
  reachable: boolean
}

// API service deployments in the portfoliost set that answer /__meta, plus
// the admin's own module. `name` is the deployment name / topology node id.
export function serviceTargets(): ServiceTarget[] {
  return [
    { name: "portfoliost-admin", url: `http://localhost:${process.env.PORT ?? 3000}` },
    { name: "portfoliost-users-auth", url: process.env.API_USERS_AUTH_URL ?? "" },
    { name: "portfoliost-wallets", url: process.env.API_WALLETS_URL ?? "" },
    { name: "portfoliost-instruments", url: process.env.API_INSTRUMENTS_URL ?? "" },
    { name: "openst", url: process.env.API_OPENST_URL ?? "" },
    { name: "cachest", url: process.env.API_CACHEST_URL ?? "" },
  ].filter((s) => s.url)
}

// Fan out /__meta to every configured service. A service that does not
// respond within 3 s is reported as unreachable with impl "unknown".
export async function probeServiceMetas(): Promise<ServiceMeta[]> {
  return Promise.all(
    serviceTargets().map(async (svc): Promise<ServiceMeta> => {
      try {
        const res = await fetch(`${svc.url}/__meta`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const meta = (await res.json()) as { service?: string; impl?: string; version?: string }
        return {
          name: svc.name,
          service: meta.service ?? svc.name,
          version: meta.version ?? "unknown",
          impl: meta.impl === "real" || meta.impl === "mock" ? meta.impl : "unknown",
          reachable: true,
        }
      } catch {
        return { name: svc.name, service: svc.name, version: "unreachable", impl: "unknown", reachable: false }
      }
    }),
  )
}