import { afterEach, describe, expect, it } from "vitest"
import { getOpenstDb } from "./index.js"

describe("OpenST database wiring", () => {
  const originalUrl = process.env.OPENST_DATABASE_URL

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.OPENST_DATABASE_URL
    else process.env.OPENST_DATABASE_URL = originalUrl
  })

  it("fails loudly when the OpenST connection is not configured", () => {
    delete process.env.OPENST_DATABASE_URL
    expect(() => getOpenstDb()).toThrow("OPENST_DATABASE_URL is not set")
  })
})
