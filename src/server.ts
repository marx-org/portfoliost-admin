import { serve } from "@hono/node-server"
import app from "./index.js"
import { getDb } from "./db/index.js"
import { startJobPoller } from "./jobs.js"

const port = parseInt(process.env.PORT ?? "3000", 10)

serve({ fetch: app.fetch, port }, () => {
  console.log(`portfoliost-admin listening on port ${port}`)
  // Start backend job poller (D53) — polls jobshot for Running jobs every 60 s,
  // persisting status changes to admin.job_run independent of any browser session.
  startJobPoller(getDb())
})
