import { date, integer, jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core"

export const adminSchema = pgSchema("admin")

/**
 * Live status of long-running jobs (D53). One row per logical job, keyed by the
 * Kubernetes Job name. The admin backend polls jobshot in the background and
 * persists changes here so job status survives browser/session expiry. Terminal
 * status is kept in place until the next run overwrites it (upsert on trigger).
 *
 * latest_date and rows_deleted are written by the post-import hook when it is
 * eventually wired (open item in admin-jobs-stooq-upload.md). Until then they
 * are null. The /log endpoint reads from this table, so the Jobs tab shows a
 * useful "Last import" timestamp (started_at) as soon as a job is triggered —
 * no separate stooq_import_log table is needed.
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
  // Post-import hook writes these when instruments confirms the load (D53):
  latestDate: date("latest_date"),     // MAX(date) from stooq foreign table
  rowsDeleted: integer("rows_deleted"), // overflow rows cleaned up
})
