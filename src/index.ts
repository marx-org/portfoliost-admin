import { Hono } from "hono"
import { logger } from "hono/logger"
import { validateJwt, userIdentityMiddleware, requireGroup } from "./auth.js"
import { moduleMeta } from "./meta.js"
import { registerJobsRoutes } from "./jobs.js"
import type { components } from "./generated/api-types"

type AdminUser = components["schemas"]["AdminUser"]
type AdminUserListResponse = components["schemas"]["AdminUserListResponse"]

const app = new Hono()

app.use("*", logger())

app.get("/health", (c) => c.json({ status: "ok" }))

// D4 — module identity/verification endpoint
app.get("/__meta", (c) => c.json(moduleMeta()))

// D9 — edge auth preflight: 204 when the bearer token validates, 401 otherwise
app.get("/internal/verify", validateJwt, (c) => c.body(null, 204))

// D50 — admin API: all /api/admin/* routes require valid JWT + portfoliost_admin group
const admin = new Hono()
admin.use("*", userIdentityMiddleware, requireGroup("portfoliost_admin"))

// D46 — system versions: aggregate /__meta from all modules
admin.get("/system/versions", async (c) => {
  const services = [
    { name: "portfoliost-admin", url: `http://localhost:${process.env.PORT ?? 3000}` },
    { name: "portfoliost-users-auth", url: process.env.API_USERS_AUTH_URL },
    { name: "portfoliost-wallets", url: process.env.API_WALLETS_URL },
    { name: "portfoliost-instruments", url: process.env.API_INSTRUMENTS_URL },
    { name: "openst", url: process.env.API_OPENST_URL },
    { name: "cachest", url: process.env.API_CACHEST_URL },
  ].filter((s) => s.url)

  const results = await Promise.all(
    services.map(async (svc) => {
      try {
        const res = await fetch(`${svc.url}/__meta`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const meta = await res.json() as { service: string; impl: string; version: string }
        return { service: meta.service ?? svc.name, version: meta.version, impl: meta.impl }
      } catch {
        return { service: svc.name, version: "unreachable", impl: "unknown" }
      }
    }),
  )

  // Also try example-service-mock (no /__meta — mark as mock)
  results.push({ service: "example-service-mock", version: "1.0.0", impl: "mock" })

  return c.json({ services: results, fetchedAt: new Date().toISOString() })
})

// D47 — proxy to wallets admin FX rates
admin.get("/currencies/rates", async (c) => {
  const walletsUrl = process.env.API_WALLETS_URL
  if (!walletsUrl) return c.json({ items: [], pagination: { total: 0, page: 1, per_page: 50, total_pages: 0 } })

  const params = new URLSearchParams()
  for (const key of ["page", "per_page", "sort_by", "sort_dir", "base_currency", "quote_currency", "date_from", "date_to"]) {
    const val = c.req.query(key)
    if (val) params.set(key, val)
  }

  try {
    const authHeader = c.req.header("Authorization") ?? ""
    const res = await fetch(`${walletsUrl}/api/admin/fx-rates?${params}`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(5000),
    })
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = { error: text }
    }
    return c.json(body, res.status as any)
  } catch (error) {
    console.error("FX-rates proxy failed:", error)
    return c.json({ error: "Upstream unavailable" }, 502)
  }
})

// D48b — users: call users-auth + enrich with OIDC UserInfo
admin.get("/users", async (c) => {  const usersAuthUrl = process.env.API_USERS_AUTH_URL
  if (!usersAuthUrl) {
    const empty: AdminUserListResponse = {
      items: [],
      pagination: { total: 0, page: 1, per_page: 50, total_pages: 0 },
    }
    return c.json(empty)
  }

  const params = new URLSearchParams()
  for (const key of ["page", "per_page", "search"]) {
    const val = c.req.query(key)
    if (val) params.set(key, val)
  }

  try {
    const authHeader = c.req.header("Authorization") ?? ""
    const listRes = await fetch(`${usersAuthUrl}/api/users/admin/list?${params}`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(5000),
    })
    const listText = await listRes.text()
    let listBody: {
      items: Array<{ userId: string; lastLogin: string | null; createdAt: string }>
      pagination: { total: number; page: number; per_page: number; total_pages: number }
    }
    try {
      listBody = JSON.parse(listText)
    } catch {
      console.error("users-auth admin/list returned non-JSON:", listRes.status, listText.slice(0, 200))
      return c.json({ error: "Upstream error" }, 502)
    }

    // Identity comes from the PocketID Admin API (X-API-KEY) — never stored
    // in portfoliost. Unconfigured/unreachable PocketID degrades to nulls.
    const pocketId = await fetchPocketIdUsers()

    const items = listBody.items.map((item): AdminUser => {
      const identity = pocketId.get(item.userId)
      return {
        id: item.userId,
        email: identity?.email ?? null,
        firstName: identity?.firstName ?? null,
        lastName: identity?.lastName ?? null,
        groups: identity?.groups ?? [],
        lastLogin: item.lastLogin ?? null,
        createdAt: item.createdAt,
      }
    })

    const response: AdminUserListResponse = { items, pagination: listBody.pagination }
    return c.json(response)
  } catch (error) {
    console.error("users proxy failed:", error)
    return c.json({ error: "Upstream unavailable" }, 502)
  }
})

interface PocketIdIdentity {
  email: string | null
  firstName: string | null
  lastName: string | null
  groups: string[]
}

async function fetchPocketIdUsers(): Promise<Map<string, PocketIdIdentity>> {
  const map = new Map<string, PocketIdIdentity>()
  const baseUrl = process.env.POCKETID_BASE_URL
  const apiKey = process.env.POCKETID_ADMIN_API_KEY
  if (!baseUrl || !apiKey) return map

  try {
    const res = await fetch(`${baseUrl}/api/users`, {
      headers: { "X-API-KEY": apiKey },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      console.error("PocketID /api/users failed:", res.status)
      return map
    }
    const body = await res.json() as {
      data?: Array<{
        id: string
        email?: string | null
        firstName?: string | null
        lastName?: string | null
        isAdmin?: boolean
        userGroups?: Array<{ name?: string } | string>
      }>
    }
    for (const u of body.data ?? []) {
      const groups = (u.userGroups ?? []).map((g) => (typeof g === "string" ? g : String(g?.name ?? ""))).filter(Boolean)
      if (u.isAdmin && !groups.includes("pocketid_admin")) groups.push("pocketid_admin")
      map.set(u.id, {
        email: u.email ?? null,
        firstName: u.firstName ?? null,
        lastName: u.lastName ?? null,
        groups,
      })
    }
  } catch (error) {
    console.error("PocketID identity fetch failed:", error)
  }
  return map
}

// N — stooq import jobs
registerJobsRoutes(admin)

app.route("/api/admin", admin)

export default app
