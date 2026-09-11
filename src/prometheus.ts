export interface PromSeries {
  metric: Record<string, string>
  value: [number, string]
}

// Thin HTTP client for the Prometheus API (instant queries). The admin pod
// reaches Prometheus in-cluster; nothing is exposed to the browser.
export async function queryInstant(query: string): Promise<PromSeries[]> {
  const promUrl = process.env.PROMETHEUS_URL
  if (!promUrl) throw new Error("PROMETHEUS_URL not configured")

  const url = new URL("/api/v1/query", promUrl)
  url.searchParams.set("query", query)

  const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error(`Prometheus query failed: HTTP ${res.status}`)

  const body = (await res.json()) as {
    status?: string
    data?: { result?: PromSeries[] }
    error?: string
  }
  if (body.status !== "success") {
    throw new Error(`Prometheus query error: ${body.error ?? "unknown"}`)
  }
  return body.data?.result ?? []
}

// Index instant-query results by a metric label (e.g. deployment), keeping the
// numeric value.
export function seriesMap(series: PromSeries[], label: string): Map<string, number> {
  const map = new Map<string, number>()
  for (const s of series) {
    const name = s.metric[label]
    if (name === undefined) continue
    map.set(name, Number.parseFloat(s.value[1]) || 0)
  }
  return map
}