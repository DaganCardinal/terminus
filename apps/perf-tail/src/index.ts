/**
 * TEMPORARY benchmark instrumentation; see wrangler.jsonc.
 *
 * Tail Worker for `terminus`: copies every `[perf]` line to R2, where
 * `GET /api/perf-logs` on Terminus reads a run back.
 */
import { perfObjects } from "./records"

export default {
  async tail(events, env) {
    await Promise.all(
      [...perfObjects(events, () => crypto.randomUUID())].map(
        ([key, records]) =>
          env.PERF_LOGS.put(key, JSON.stringify(records), {
            httpMetadata: { contentType: "application/json" },
          })
      )
    )
  },
} satisfies ExportedHandler<Env>
