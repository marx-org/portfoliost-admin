#!/usr/bin/env node
// §80.2 — tripwire for the hardcoded CronJob list in src/jobs-version.ts.
//
// The list is hand-curated because the pfire namespace is shared (pgdb, the
// CrunchyData pgBackRest jobs, scanst, stooq and other tenants live there too),
// so "ours" is a decision, not a query. The cost of curating by hand is drift:
// §80.1 found seven portfoliost CronJobs missing from the System tab and one
// dead name in it, the oldest 12 days old.
//
// This reads the live namespace and compares it against
// src/cronjobs.fixture.json — a capture taken on 2026-10-02. It exits non-zero
// on any difference in name, schedule or suspend flag for the jobs it owns,
// and ignores everything in the namespace it does not own.
//
//   node scripts/check-cronjobs.mjs              # diff against the fixture
//   node scripts/check-cronjobs.mjs --refresh    # rewrite the fixture
//   KUBECONFIG=$HOME/.kube/homylab node scripts/check-cronjobs.mjs
//
// Its honest limit: it cannot fail on its own. The fixture only changes when
// someone runs --refresh, so this catches a job edited in a HelmRelease
// without a resync, and nothing more — a job *added* to the cluster still has
// to be added to CRONJOBS and the fixture by hand. Wiring this into CI
// against the live cluster is the follow-up that would make it self-firing;
// it needs a kubeconfig in CI.

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const FIXTURE = new URL("../src/cronjobs.fixture.json", import.meta.url)
const NAMESPACE = process.env.K8S_NAMESPACE ?? "pfire"
const refresh = process.argv.includes("--refresh")

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"))
const owned = new Set(fixture.cronjobs.map((c) => c.name))

let live
try {
  const out = execFileSync("kubectl", ["get", "cronjobs", "-n", NAMESPACE, "-o", "json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  live = JSON.parse(out).items ?? []
} catch (e) {
  console.error(`cannot read cronjobs in ${NAMESPACE}: ${e.message.trim().split("\n")[0]}`)
  console.error("set KUBECONFIG (e.g. export KUBECONFIG=$HOME/.kube/homylab) and try again")
  process.exit(2)
}

const summarize = (cj) => ({
  name: cj.metadata.name,
  schedule: cj.spec.schedule,
  suspend: cj.spec.suspend ?? false,
  image: cj.spec?.jobTemplate?.spec?.template?.spec?.containers?.[0]?.image,
})

const liveOwned = live
  .map(summarize)
  .filter((cj) => owned.has(cj.name))
  .sort((a, b) => a.name.localeCompare(b.name))

if (refresh) {
  fixture.capturedAt = new Date().toISOString().slice(0, 10)
  fixture.cronjobs = liveOwned.map(({ name, schedule, suspend, image }) => ({ name, schedule, suspend, image }))
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`)
  console.log(`refreshed ${fixture.cronjobs.length} CronJobs into ${fileURLToPath(FIXTURE)} (${fixture.capturedAt})`)
  process.exit(0)
}

const diffs = []
for (const expected of fixture.cronjobs) {
  const actual = liveOwned.find((cj) => cj.name === expected.name)
  if (!actual) {
    diffs.push(`${expected.name}: in the fixture, not in ${NAMESPACE} (removed or renamed?)`)
    continue
  }
  if (actual.schedule !== expected.schedule) {
    diffs.push(`${expected.name}: schedule ${JSON.stringify(expected.schedule)} -> ${JSON.stringify(actual.schedule)}`)
  }
  if (actual.suspend !== expected.suspend) {
    diffs.push(`${expected.name}: suspend ${expected.suspend} -> ${actual.suspend}`)
  }
}

// Names in the cluster that the fixture does not own are silent on purpose:
// the namespace is shared, so an unknown name is far more likely to be
// someone else's than a job we forgot.
if (diffs.length) {
  console.error(`CronJob drift against the fixture captured ${fixture.capturedAt}:`)
  for (const d of diffs) console.error(`  ${d}`)
  console.error("")
  console.error("if these changes are intended: update the HelmRelease, then")
  console.error("  node scripts/check-cronjobs.mjs --refresh")
  console.error("and add any new job to CRONJOBS in src/jobs-version.ts")
  process.exit(1)
}

console.log(`${liveOwned.length} portfoliost-owned CronJobs match the fixture (${fixture.capturedAt})`)