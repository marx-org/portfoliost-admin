import { describe, it, expect } from "vitest"
import fixture from "./cronjobs.fixture.json" with { type: "json" }
import { CRONJOBS } from "./jobs-version.js"

describe("CRONJOBS against the captured cluster fixture (§80.2)", () => {
  it("holds exactly the names in the fixture", () => {
    expect([...CRONJOBS].sort()).toEqual(fixture.cronjobs.map((c) => c.name).sort())
  })

  it("agrees with the fixture on schedule and suspend, so a manifest edit without a resync fails here", () => {
    const fromCode = Object.fromEntries(CRONJOBS.map((n) => [n, fixture.cronjobs.find((c) => c.name === n)]))
    for (const c of fixture.cronjobs) {
      expect(fromCode[c.name], `${c.name} is in CRONJOBS`).toBeTruthy()
    }
    // The fixture is the record of what the cluster declared on its capture
    // date; scripts/check-cronjobs.mjs is what proves the cluster still agrees.
    expect(fixture.cronjobs.filter((c) => c.suspend).map((c) => c.name)).toEqual([
      "openst-cpi-seed",
      "stooq-downloader",
      "stooq-importer",
    ])
    expect(fixture.cronjobs.every((c) => typeof c.schedule === "string" && c.schedule.length > 0)).toBe(true)
  })

  it("owns no foreign tenant of the shared pfire namespace", () => {
    const names = fixture.cronjobs.map((c) => c.name)
    for (const foreign of [
      "pgdb",
      "stooq",
      "scanst",
      "scanst-override",
      "scanst-test",
      "postgres-pfire-repo1-diff",
      "postgres-pfire-repo1-full",
      "postgres-pfire-repo1-incr",
    ]) {
      expect(names).not.toContain(foreign)
    }
  })
})