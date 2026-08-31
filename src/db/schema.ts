import { jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core"

export const adminSchema = pgSchema("admin")

/**
 * Live status of long-running jobs (D53). One row per logical job, keyed by the
 * Kubernetes Job name. The admin backend polls jobshot in the background and
 * persists changes here so job status survives browser/session expiry. Terminal
 * status is kept in place until the next run overwrites it (upsert on trigger).
 */
export const jobRun = adminSchema.table("job_run", {
  name: text("name").primaryKey(),
  namespace: text("namespace").notNull(),
  kind: text("kind").notNull().default("stooq_import"),
  param: text("param"),
  status: text("status").notNull(), // Running | Succeeded | Failed | NotFound
  details: jsonb("details"), // { active, succeeded, failed } pod counts
  startedAt: timestamp("started_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})
