import { afterEach, describe, expect, it } from "vitest"
import { buildCashAuditSpec, CASH_AUDIT_JOB_NAME } from "./cash-audit.js"

describe("cash audit job spec", () => {
  const previousImage = process.env.SHEETS_SYNC_IMAGE

  afterEach(() => {
    if (previousImage === undefined) delete process.env.SHEETS_SYNC_IMAGE
    else process.env.SHEETS_SYNC_IMAGE = previousImage
  })

  it("runs the read-only audit in the pinned sheets-sync image", () => {
    process.env.SHEETS_SYNC_IMAGE = "ghcr.io/marx2/portfoliost-sheets-sync:v1.0.42"
    process.env.API_WALLETS_URL = "http://wallets:3000"
    const spec = buildCashAuditSpec("caller-token")
    expect(spec.name).toBe(CASH_AUDIT_JOB_NAME)
    expect(spec.container).toBe(process.env.SHEETS_SYNC_IMAGE)
    expect(spec.entrypoint).toEqual(["node", "dist/cash-audit.js"])
    expect(spec.secretName).toBe("sheets-sync-secrets")
    expect(spec.env).toMatchObject({ WALLETS_API_URL: "http://wallets:3000", WALLETS_API_TOKEN: "caller-token" })
  })
})
