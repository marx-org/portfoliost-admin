import { serve } from "@hono/node-server"
import "./instrumentation.js"
import app from "./index.js"
import { getDb } from "./db/index.js"
import { startJobPoller } from "./jobs.js"
import { setMarketDataDb } from "./market-data.js"

const port = parseInt(process.env.PORT ?? "3000", 10)

serve({ fetch: app.fetch, port }, () => {
  console.log(`portfoliost-admin listening on port ${port}`)
  const db = getDb()
  startJobPoller(db)
  setMarketDataDb(db)
})
