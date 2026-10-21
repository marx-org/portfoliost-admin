import { describe, expect, it } from "vitest"
import { internalServiceUrl } from "./internal-url.js"

describe("internalServiceUrl", () => {
  it("accepts approved service origins and removes trailing slashes", () => {
    expect(internalServiceUrl("http://instruments:3000/", "", "instruments")).toBe("http://instruments:3000")
    expect(internalServiceUrl("http://portfoliost-wallets.pfire.svc.cluster.local:3000", "", "wallets"))
      .toBe("http://portfoliost-wallets.pfire.svc.cluster.local:3000")
    expect(internalServiceUrl("http://pocket-id.networking.svc.cluster.local:1411", "", "pocket-id"))
      .toBe("http://pocket-id.networking.svc.cluster.local:1411")
  })

  it("rejects external, cross-service, and path-bearing destinations", () => {
    expect(internalServiceUrl("https://attacker.example", "", "instruments")).toBe("")
    expect(internalServiceUrl("http://wallets:3000", "", "instruments")).toBe("")
    expect(internalServiceUrl("http://instruments:3000/private", "", "instruments")).toBe("")
    expect(internalServiceUrl("http://instruments:3000?next=http://attacker", "", "instruments")).toBe("")
    expect(internalServiceUrl("not a URL", "", "instruments")).toBe("")
  })

  it("allows the PocketID fixture only outside production", () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "test"
    try {
      expect(internalServiceUrl("https://pocket-id.example", "", "pocket-id")).toBe("https://pocket-id.example")
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
    }
  })
})
