const localHosts = new Set(["localhost", "127.0.0.1", "::1", "jobshot", "instruments", "wallets", "users-auth", "openst", "cachest"])

export function internalServiceUrl(value: string | undefined, fallback = ""): string {
  const candidate = value || fallback
  if (!candidate) return ""
  const url = new URL(candidate)
  const hostname = url.hostname.toLowerCase()
  const testHost = process.env.NODE_ENV !== "production" && (hostname.endsWith("-test") || hostname.endsWith(".test") || hostname.endsWith(".example"))
  const clusterHost = hostname.endsWith(".svc") || hostname.endsWith(".svc.cluster.local")
  const homelabHost = hostname.endsWith(".k.homylab.com")
  if (!["http:", "https:"].includes(url.protocol) ||
      !(localHosts.has(hostname) || testHost || clusterHost || homelabHost)) {
    throw new Error("upstream URL is not an approved internal service")
  }
  return url.origin
}
