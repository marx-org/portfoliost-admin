export type InternalService =
  | "jobshot"
  | "users-auth"
  | "wallets"
  | "instruments"
  | "openst"
  | "cachest"
  | "pocket-id"

/**
 * Return only an explicitly approved origin for the requested service.
 *
 * The return values are literals rather than the configured string. This is
 * both a strict service allowlist and an explicit CodeQL sanitizer: an
 * attacker-controlled URL can never reach an outbound request merely because
 * it resembles an internal URL. Paths, queries, fragments, credentials, and
 * cross-service destinations are rejected.
 */
export function internalServiceUrl(
  value: string | undefined,
  fallback: string,
  service: InternalService,
): string {
  const candidate = (value || fallback).replace(/\/+$/, "")
  if (!candidate) return ""

  switch (service) {
    case "jobshot":
      if (candidate === "http://jobshot:3000") return "http://jobshot:3000"
      if (candidate === "http://jobshot-test:3000") return "http://jobshot-test:3000"
      if (candidate === "http://jobshot.pfire.svc:3000") return "http://jobshot.pfire.svc:3000"
      if (candidate === "http://jobshot.pfire.svc.cluster.local:3000") {
        return "http://jobshot.pfire.svc.cluster.local:3000"
      }
      return ""

    case "users-auth":
      if (candidate === "http://users-auth:3000") return "http://users-auth:3000"
      if (candidate === "http://users-auth-test:3000") return "http://users-auth-test:3000"
      if (candidate === "http://portfoliost-users-auth:3000") return "http://portfoliost-users-auth:3000"
      if (candidate === "http://portfoliost-users-auth.pfire.svc:3000") {
        return "http://portfoliost-users-auth.pfire.svc:3000"
      }
      if (candidate === "http://portfoliost-users-auth.pfire.svc.cluster.local:3000") {
        return "http://portfoliost-users-auth.pfire.svc.cluster.local:3000"
      }
      return ""

    case "wallets":
      if (candidate === "http://wallets:3000") return "http://wallets:3000"
      if (candidate === "http://wallets-test:3000") return "http://wallets-test:3000"
      if (candidate === "http://portfoliost-wallets:3000") return "http://portfoliost-wallets:3000"
      if (candidate === "http://portfoliost-wallets.pfire.svc:3000") {
        return "http://portfoliost-wallets.pfire.svc:3000"
      }
      if (candidate === "http://portfoliost-wallets.pfire.svc.cluster.local:3000") {
        return "http://portfoliost-wallets.pfire.svc.cluster.local:3000"
      }
      return ""

    case "instruments":
      if (candidate === "http://instruments:3000") return "http://instruments:3000"
      if (candidate === "http://instruments-test:3000") return "http://instruments-test:3000"
      if (candidate === "http://portfoliost-instruments:3000") return "http://portfoliost-instruments:3000"
      if (candidate === "http://portfoliost-instruments.pfire.svc:3000") {
        return "http://portfoliost-instruments.pfire.svc:3000"
      }
      if (candidate === "http://portfoliost-instruments.pfire.svc.cluster.local:3000") {
        return "http://portfoliost-instruments.pfire.svc.cluster.local:3000"
      }
      return ""

    case "openst":
      if (candidate === "http://openst:8080") return "http://openst:8080"
      if (candidate === "http://openst-test:8080") return "http://openst-test:8080"
      if (candidate === "http://openst.pfire.svc:8080") return "http://openst.pfire.svc:8080"
      if (candidate === "http://openst.pfire.svc.cluster.local:8080") {
        return "http://openst.pfire.svc.cluster.local:8080"
      }
      return ""

    case "cachest":
      if (candidate === "http://cachest:8080") return "http://cachest:8080"
      if (candidate === "http://cachest-test:8080") return "http://cachest-test:8080"
      if (candidate === "http://cachest.pfire.svc:8080") return "http://cachest.pfire.svc:8080"
      if (candidate === "http://cachest.pfire.svc.cluster.local:8080") {
        return "http://cachest.pfire.svc.cluster.local:8080"
      }
      return ""

    case "pocket-id":
      if (candidate === "http://pocket-id.networking.svc.cluster.local:1411") {
        return "http://pocket-id.networking.svc.cluster.local:1411"
      }
      if (candidate === "https://pocket-id.k.homylab.com") return "https://pocket-id.k.homylab.com"
      if (process.env.NODE_ENV !== "production" && candidate === "https://pocket-id.example") {
        return "https://pocket-id.example"
      }
      return ""
  }
}
