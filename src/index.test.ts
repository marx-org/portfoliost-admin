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

  it("proxies users to users-auth /api/users/admin/list", async () => {
    process.env.API_USERS_AUTH_URL = "http://users-auth:3000"
    delete process.env.API_WALLETS_URL
    delete process.env.OIDC_ISSUER_URL
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
      const res = await app.request("/api/admin/users", { headers: adminHeaders })
      expect(res.status).toBe(200)
      expect(seen[0]).toBe("http://users-auth:3000/api/users/admin/list?")
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
})
