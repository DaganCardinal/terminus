import {
  repositoryChangesQuerySchema,
  repositoryChangeFileQuerySchema,
  repositoryChangesSchema,
  repositoryChangeFileSchema,
} from "@terminus/protocol"
import { dispatcherPorts } from "../agents/ports"

/** Browsing resolves existing provenance only; it never writes D1 or starts execution. */
export async function readTrainChanges(
  request: Request,
  env: Env,
  trainId: string,
  carId?: string,
  file = false
): Promise<Response> {
  const query = (
    file ? repositoryChangeFileQuerySchema : repositoryChangesQuerySchema
  ).safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!query.success)
    return Response.json(
      {
        error: "base and head are required, with a valid path for a file diff",
        details: query.error.issues,
      },
      { status: 400 }
    )
  const { store, repositories } = dispatcherPorts(env)
  const loaded = await store.train(trainId)
  if (!loaded) return Response.json({ error: "Unknown Train" }, { status: 404 })
  const train = loaded.value
  const car = carId
    ? (await store.trainCars(trainId)).find((car) => car.id === carId)
    : undefined
  if (carId && !car)
    return Response.json(
      { error: "Unknown Car on this Train" },
      { status: 404 }
    )
  const base = car?.sourceCommit ?? train.terminusBaseline
  const head = car?.acceptedCommit ?? train.headCommit
  if (query.data.base !== base || query.data.head !== head) {
    return Response.json(
      {
        error:
          "The accepted snapshot has changed. Reopen Changes to load the current snapshot.",
      },
      { status: 409 }
    )
  }
  // Copied Cars retain their original commit pair, both reachable in the receiving Train.
  const body =
    file && "path" in query.data && typeof query.data.path === "string"
      ? await repositories.readChangeFile(
          train.repoId,
          base,
          head,
          query.data.path
        )
      : await repositories.readChanges(train.repoId, base, head)
  if (!body)
    return Response.json({ error: "No such changed file" }, { status: 404 })
  return Response.json(
    file
      ? repositoryChangeFileSchema.parse(body)
      : repositoryChangesSchema.parse(body),
    {
      // The URL names the exact immutable comparison; only private browser caching is allowed.
      headers: { "cache-control": "private, max-age=86400, immutable" },
    }
  )
}
