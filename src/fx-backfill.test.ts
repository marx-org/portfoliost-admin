import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { buildFxBackfillSpec, FX_BACKFILL_JOB_NAME } from "./fx-backfill.js"

describe("buildFxBackfillSpec (§72.24)", () => {
  const previousImage = process.env.INSTRUMENTS_IMAGE

  afterEach(() => {
    if (previousImage === undefined) delete process.env.INSTRUMENTS_IMAGE
    else process.env.INSTRUMENTS_IMAGE = previousImage
  })

  it("runs the instruments image, since that is where the script lives", () => {
    const s = buildFxBackfillSpec()
    expect(s.name).toBe(FX_BACKFILL_JOB_NAME)
    expect(s.container).toMatch(/portfoliost-instruments/)
  })

  // #172 — the sibling price-audit job falls back to a *pinned* org tag. This
  // one fell back to `ghcr.io/marx2/portfoliost-instruments:latest`, which is
  // wrong twice: the old namespace still resolves but is frozen at the transfer
  // build, and `:latest` contradicts the comment above it about pinning a job
  // that writes the FX table. Assert both properties so neither can regress.
  it("falls back to a pinned org image, not :latest and not the old namespace", () => {
    delete process.env.INSTRUMENTS_IMAGE

    const container = buildFxBackfillSpec().container
    expect(container).toMatch(/^ghcr\.io\/marx-org\/portfoliost-instruments:v\d+\.\d+\.\d+$/)
    expect(container).not.toContain("marx2")
    expect(container).not.toContain(":latest")
  })

  it("still honours an explicit INSTRUMENTS_IMAGE override", () => {
    process.env.INSTRUMENTS_IMAGE = "ghcr.io/marx-org/portfoliost-instruments:v9.9.9"
    expect(buildFxBackfillSpec().container).toBe("ghcr.io/marx-org/portfoliost-instruments:v9.9.9")
  })

  it("exports DATABASE_URL from the pguser secret's `uri` key", () => {
    // jobshot wires the Secret through envFrom, and its key is `uri` — not
    // DATABASE_URL. Without the wrapper the Job starts and cannot connect.
    const cmd = buildFxBackfillSpec().parameters[0]
    expect(cmd).toContain('export DATABASE_URL="$uri"')
    expect(cmd).toContain("dist/scripts/fx-backfill.js")
  })

  it("passes no --start, so coverage comes from the script's DEFAULT_HISTORY_START", () => {
    // A date in a helm value would make the Job's reach a function of config
    // rather than of the script; 1999-01-04 is the point of the import.
    expect(buildFxBackfillSpec().parameters[0]).not.toContain("--start")
  })

  it("uses the mounted pguser secret", () => {
    expect(buildFxBackfillSpec().secretName).toBe("postgres-pfire-pguser-portfoliost")
  })
})
