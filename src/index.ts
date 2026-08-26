import { Hono } from "hono"
import { logger } from "hono/logger"
import { validateJwt, userIdentityMiddleware, requireGroup } from "./auth.js"
import { moduleMeta } from "./meta.js"

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

  // Also try stoxly-mock (no /__meta — mark as mock)
  results.push({ service: "stoxly-mock", version: "1.0.0", impl: "mock" })

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
admin.get("/users", async (c) => {
  const usersAuthUrl = process.env.API_USERS_AUTH_URL
  if (!usersAuthUrl) return c.json({ items: [], pagination: { total: 0, page: 1, per_page: 50, total_pages: 0 } })

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
      items: Array<{
        userId: string
        email: string | null
        firstName: string | null
        lastName: string | null
        groups: string[] | null
        lastLogin: string | null
        createdAt: string
      }>
      pagination: { total: number; page: number; per_page: number; total_pages: number }
    }
    try {
      listBody = JSON.parse(listText)
    } catch {
      console.error("users-auth admin/list returned non-JSON:", listRes.status, listText.slice(0, 200))
      return c.json({ error: "Upstream error" }, 502)
    }

    // D48b amendment: users-auth persists identity at token exchange, so
    // this is a pure pass-through (no OIDC calls — client-credentials
    // tokens have no user subject and /userinfo is per-token-sub anyway).
    const items = listBody.items.map((item) => ({
      id: item.userId,
      email: item.email,
      firstName: item.firstName,
      lastName: item.lastName,
      groups: item.groups ?? [],
      lastLogin: item.lastLogin,
      createdAt: item.createdAt,
    }))

    return c.json({ items, pagination: listBody.pagination })
  } catch (error) {
    console.error("users proxy failed:", error)
    return c.json({ error: "Upstream unavailable" }, 502)
  }
})

app.route("/api/admin", admin)

export default app
