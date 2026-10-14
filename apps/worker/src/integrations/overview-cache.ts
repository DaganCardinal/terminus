import { parseRepoId, type RepositoryHost } from "@terminus/artifacts"
import {
  repositoryOverviewSchema,
  type RepositoryOverview,
} from "@terminus/protocol"

/** Half of D1's 2 MB row limit, leaving room for the key columns. */
const CHUNK_BYTES = 1_000_000

/**
 * Serves `readOverview` from D1 after the first read of each commit. An
 * overview is addressed by its commit and never changes, so its object reads
 * run once per commit instead of once per page view.
 */
export function cacheOverviews(
  host: RepositoryHost,
  db: D1Database,
  chunkBytes = CHUNK_BYTES
): void {
  const read = host.readOverview.bind(host)
  host.readOverview = async (repoId, commit) => {
    const cached = await readCached(db, repoId, commit)
    if (cached) return cached
    const overview = await read(repoId, commit)
    try {
      await writeCached(db, repoId, commit, overview, chunkBytes)
    } catch (error) {
      // The reader already paid for this overview; the next view retries.
      console.error(
        "Could not cache repository overview",
        repoId,
        commit,
        error
      )
    }
    return overview
  }
}

async function readCached(
  db: D1Database,
  repoId: string,
  commit: string
): Promise<RepositoryOverview | null> {
  const { results } = await db
    .prepare(
      "SELECT chunks, data FROM repository_overviews WHERE repo_id = ? AND commit_id = ? ORDER BY chunk"
    )
    .bind(repoId, commit)
    .all<{ chunks: number; data: ArrayBuffer | number[] }>()
  if (!results.length || results.length !== results[0]!.chunks) return null
  const compressed = new Blob(results.map((row) => new Uint8Array(row.data)))
  const json = await new Response(
    compressed.stream().pipeThrough(new DecompressionStream("gzip"))
  ).text()
  return repositoryOverviewSchema.parse(JSON.parse(json))
}

async function writeCached(
  db: D1Database,
  repoId: string,
  commit: string,
  overview: RepositoryOverview,
  chunkBytes: number
): Promise<void> {
  const bytes = new Uint8Array(
    await new Response(
      new Blob([JSON.stringify(overview)])
        .stream()
        .pipeThrough(new CompressionStream("gzip"))
    ).arrayBuffer()
  )
  const chunks = Math.ceil(bytes.length / chunkBytes)
  const { namespace } = parseRepoId(repoId)
  // Replace rather than merge, so concurrent first views never mix chunks.
  await db.batch([
    db
      .prepare(
        "DELETE FROM repository_overviews WHERE repo_id = ? AND commit_id = ?"
      )
      .bind(repoId, commit),
    ...Array.from({ length: chunks }, (_, chunk) =>
      db
        .prepare(
          "INSERT INTO repository_overviews (repo_id, commit_id, chunk, chunks, namespace, data) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(
          repoId,
          commit,
          chunk,
          chunks,
          namespace,
          bytes.slice(chunk * chunkBytes, (chunk + 1) * chunkBytes).buffer
        )
    ),
  ])
}
