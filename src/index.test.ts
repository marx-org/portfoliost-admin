import { describe, it, expect } from "vitest"
import app from "./index.js"

describe("GET /health", () => {
  it("returns status ok", async () => {
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })
})

describe("GET /__meta", () => {
  it("returns module identity per D4", async () => {
    const res = await app.request("/__meta")
    expect(res.status).toBe(200)
    const meta = await res.json()
    expect(meta.service).toBe("admin")
    expect(meta.impl).toBe("real")
    expect(typeof meta.version).toBe("string")
    expect(meta.version.length).toBeGreaterThan(0)
  })
})

describe("Admin proxies hit module /api-prefixed routes", () => {
  const adminHeaders = {
    "X-User-Id": "admin-1",
    "X-User-Email": "admin@example.com",
    "X-User-Groups": "portfoliost_admin",
  }

  it("proxies currencies/rates to wallets /api/admin/fx-rates", async () => {
    process.env.API_WALLETS_URL = "http://wallets:3000"
    delete process.env.API_USERS_AUTH_URL
    const seen: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      seen.push(url)
      return new Response(JSON.stringify({ items: [], pagination: { total: 0, page: 1, per_page: 50, total_pages: 0 } }), {
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    try {
      const res = await app.request("/api/admin/currencies/rates?page=2", { headers: adminHeaders })
      expect(res.status).toBe(200)
      expect(seen[0]).toBe("http://wallets:3000/api/admin/fx-rates?page=2")
    } finally {
      globalThis.fetch = origFetch
      delete process.env.API_WALLETS_URL
    }
  })

  it("merges users-auth rows with PocketID identity by user id", async () => {
    process.env.API_USERS_AUTH_URL = "http://users-auth:3000"
    process.env.POCKETID_BASE_URL = "https://pocket-id.example"
    process.env.POCKETID_ADMIN_API_KEY = "test-key"
    delete process.env.API_WALLETS_URL
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("/api/users/admin/list")) {
        return new Response(JSON.stringify({
          items: [{ userId: "uuid-1", lastLogin: "2026-08-22T09:00:00Z", createdAt: "2026-08-22T09:00:00Z" }],
          pagination: { total: 1, page: 1, per_page: 50, total_pages: 1 },
        }), { headers: { "content-type": "application/json" } })
      }
      if (url === "https://pocket-id.example/api/users") {
        expect((init?.headers as Record<string, string>)["X-API-KEY"]).toBe("test-key")
        return new Response(JSON.stringify({
          data: [{
            id: "uuid-1",
            email: "alice@example.com",
            firstName: "Alice",
            lastName: "Smith",
            isAdmin: false,
            userGroups: [{ name: "portfoliost_admin" }],
          }],
        }), { headers: { "content-type": "application/json" } })
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch
    try {
      const res = await app.request("/api/admin/users", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.items[0]).toEqual({
        id: "uuid-1",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Smith",
        groups: ["portfoliost_admin"],
        lastLogin: "2026-08-22T09:00:00Z",
        createdAt: "2026-08-22T09:00:00Z",
      })
    } finally {
      globalThis.fetch = origFetch
      delete process.env.API_USERS_AUTH_URL
      delete process.env.POCKETID_BASE_URL
      delete process.env.POCKETID_ADMIN_API_KEY
    }
  })

  it("degrades identity fields to nulls when PocketID is not configured", async () => {
    process.env.API_USERS_AUTH_URL = "http://users-auth:3000"
    delete process.env.API_WALLETS_URL
    delete process.env.POCKETID_BASE_URL
    delete process.env.POCKETID_ADMIN_API_KEY
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("/api/users/admin/list")) {
        return new Response(JSON.stringify({
          items: [{ userId: "uuid-1", lastLogin: "2026-08-22T09:00:00Z", createdAt: "2026-08-22T09:00:00Z" }],
          pagination: { total: 1, page: 1, per_page: 50, total_pages: 1 },
        }), { headers: { "content-type": "application/json" } })
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch
    try {
      const res = await app.request("/api/admin/users", { headers: adminHeaders })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.items[0].email).toBeNull()
      expect(data.items[0].groups).toEqual([])
      expect(data.items[0].lastLogin).toBe("2026-08-22T09:00:00Z")
    } finally {
      globalThis.fetch = origFetch
      delete process.env.API_USERS_AUTH_URL
    }
  })
})

describe("GET /internal/verify", () => {
  it("rejects missing bearer token with 401", async () => {
    const res = await app.request("/internal/verify")
    expect(res.status).toBe(401)
  })

  it("rejects invalid bearer token with 401", async () => {
    const res = await app.request("/internal/verify", {
      headers: { Authorization: "Bearer not-a-jwt" },
    })
    expect(res.status).toBe(401)
  })

  it("returns 204 for a token signed by the issuer", async () => {
    const issuer = "http://admin-jwks.test"
    process.env.POCKETID_ISSUER_URL = issuer
    process.env.POCKETID_AUDIENCE = "test-audience"
    const { SignJWT, generateKeyPair, exportJWK } = await import("jose")
    const alg = "ES256"
    const { publicKey, privateKey } = await generateKeyPair(alg)
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg, use: "sig" }] }
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } })) as typeof fetch
    try {
      const token = await new SignJWT({ email: "t@example.com" })
        .setProtectedHeader({ alg, kid: "test-key" })
        .setSubject("user-1")
        .setIssuer(issuer)
        .setAudience("test-audience")
        .setExpirationTime("5m")
        .sign(privateKey)
      const res = await app.request("/internal/verify", {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(204)
    } finally {
      globalThis.fetch = origFetch
      delete process.env.POCKETID_ISSUER_URL
      delete process.env.POCKETID_AUDIENCE
    }
  })
})

describe("Admin API authorization (D50)", () => {
  it("rejects unauthenticated request to /api/admin/system/versions with 401", async () => {
    const res = await app.request("/api/admin/system/versions")
    expect(res.status).toBe(401)
  })

  it("rejects non-admin X-User-Groups with 403", async () => {
    const res = await app.request("/api/admin/system/versions", {
      headers: {
        "X-User-Id": "user-1",
        "X-User-Email": "test@example.com",
        "X-User-Groups": "portfoliost_user",
      },
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe("Forbidden")
  })

  it("allows admin X-User-Groups to /api/admin/system/versions", async () => {
    // Mock all upstream /__meta calls
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("/__meta")) {
        return new Response(JSON.stringify({ service: "test", impl: "real", version: "0.0.1" }), {
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch
    try {
      const res = await app.request("/api/admin/system/versions", {
        headers: {
          "X-User-Id": "admin-1",
          "X-User-Email": "admin@example.com",
          "X-User-Groups": "portfoliost_admin",
        },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.services).toBeDefined()
      expect(Array.isArray(body.services)).toBe(true)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it("aggregates openst and cachest versions when their URLs are configured", async () => {
    const prevOpen = process.env.API_OPENST_URL
    const prevCache = process.env.API_CACHEST_URL
    process.env.API_OPENST_URL = "http://openst:8080"
    process.env.API_CACHEST_URL = "http://cachest:8080"

    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "http://openst:8080/__meta") {
        return new Response(JSON.stringify({ service: "openst", impl: "real", version: "1.0.18" }), {
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "http://cachest:8080/__meta") {
        return new Response(JSON.stringify({ service: "cachest", impl: "real", version: "1.0.21" }), {
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch
    try {
      const res = await app.request("/api/admin/system/versions", {
        headers: {
          "X-User-Id": "admin-1",
          "X-User-Email": "admin@example.com",
          "X-User-Groups": "portfoliost_admin",
        },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      const services = body.services as { service: string; version: string; impl: string }[]
      const openst = services.find((s) => s.service === "openst")
      const cachest = services.find((s) => s.service === "cachest")
      expect(openst).toEqual({ service: "openst", version: "1.0.18", impl: "real" })
      expect(cachest).toEqual({ service: "cachest", version: "1.0.21", impl: "real" })
    } finally {
      globalThis.fetch = origFetch
      if (prevOpen === undefined) delete process.env.API_OPENST_URL
      else process.env.API_OPENST_URL = prevOpen
      if (prevCache === undefined) delete process.env.API_CACHEST_URL
      else process.env.API_CACHEST_URL = prevCache
    }
  })
})
