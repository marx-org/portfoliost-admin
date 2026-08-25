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
      items: Array<{ userId: string; createdAt: string; updatedAt: string }>
      pagination: { total: number; page: number; per_page: number; total_pages: number }
    }
    try {
      listBody = JSON.parse(listText)
    } catch {
      console.error("users-auth admin/list returned non-JSON:", listRes.status, listText.slice(0, 200))
      return c.json({ error: "Upstream error" }, 502)
    }

    // Attempt OIDC enrichment (best-effort — skip if not configured)
    const issuerUrl = process.env.OIDC_ISSUER_URL
    const clientId = process.env.OIDC_CLIENT_ID
    const clientSecret = process.env.OIDC_CLIENT_SECRET

    type EnrichedUser = { id: string; email: string | null; firstName: string | null; lastName: string | null; groups: string[]; createdAt: string }
    let enrichedItems: EnrichedUser[] = listBody.items.map((item) => ({
      id: item.userId, email: null, firstName: null, lastName: null, groups: [], createdAt: item.createdAt,
    }))

    if (issuerUrl && clientId && clientSecret) {
      try {
        // Client credentials token
        const tokenRes = await fetch(`${issuerUrl}/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
            scope: "openid profile email groups",
          }),
          signal: AbortSignal.timeout(5000),
        })
        const tokenBody = await tokenRes.json() as { access_token?: string }

        if (tokenBody.access_token) {
          enrichedItems = await Promise.all(
            listBody.items.map(async (item): Promise<EnrichedUser> => {
              try {
                const userInfoRes = await fetch(`${issuerUrl}/oauth2/userinfo`, {
                  headers: { Authorization: `Bearer ${tokenBody.access_token}` },
                  signal: AbortSignal.timeout(3000),
                })
                if (!userInfoRes.ok) return { id: item.userId, email: null, firstName: null, lastName: null, groups: [], createdAt: item.createdAt }
                const info = await userInfoRes.json() as Record<string, unknown>
                return {
                  id: item.userId,
                  email: (info.email as string) ?? null,
                  firstName: (info.given_name as string) ?? null,
                  lastName: (info.family_name as string) ?? null,
                  groups: (info.groups as string[]) ?? [],
                  createdAt: item.createdAt,
                }
              } catch {
                return { id: item.userId, email: null, firstName: null, lastName: null, groups: [], createdAt: item.createdAt }
              }
            }),
          )
        }
      } catch {
        // OIDC unavailable — return basic items
      }
    }

    return c.json({ items: enrichedItems, pagination: listBody.pagination })
  } catch (error) {
    console.error("users proxy failed:", error)
    return c.json({ error: "Upstream unavailable" }, 502)
  }
})

app.route("/api/admin", admin)

export default app
