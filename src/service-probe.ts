import { internalServiceUrl, type InternalService } from "./internal-url.js"

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
  const configured = [
    { name: "portfoliost-users-auth", value: process.env.API_USERS_AUTH_URL, service: "users-auth" as const },
    { name: "portfoliost-wallets", value: process.env.API_WALLETS_URL, service: "wallets" as const },
    { name: "portfoliost-instruments", value: process.env.API_INSTRUMENTS_URL, service: "instruments" as const },
    { name: "openst", value: process.env.API_OPENST_URL, service: "openst" as const },
    { name: "cachest", value: process.env.API_CACHEST_URL, service: "cachest" as const },
  ] satisfies Array<{ name: string; value: string | undefined; service: InternalService }>

  return [
    { name: "portfoliost-admin", url: "http://localhost:3000" },
    ...configured.flatMap(({ name, value, service }) => {
      const url = internalServiceUrl(value, "", service)
      return url ? [{ name, url }] : []
    }),
  ]
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
