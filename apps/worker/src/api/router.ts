import { layJunction } from "../agents/junctions"
import { emergencyBrake } from "../agents/emergency-brake"
import {
  alternativeHarnessesEnabled,
  unavailableHarnessSettings,
} from "../integrations/harness-availability"
import {
  dispatchJunctionRepair,
  approveJunctionRepair,
} from "../agents/junction-repairs"
import { junctionDispatchPorts } from "../agents/ports"
import {
  selectPlanUnloadMode,
  updateTrainUnload,
} from "../agents/unload-control"
import { dispatchTechnician, approveTechnician } from "../agents/technician"
import { networkModels, technicianPorts } from "../agents/ports"
import {
  createJunctionRequestSchema,
  releaseJunctionRequestSchema,
  junctionRepairRequestSchema,
  terminusPreviewRequestSchema,
  stopPreviewRequestSchema,
  stopStationSandboxRequestSchema,
  emergencyBrakeRequestSchema,
  setUnloadModeRequestSchema,
  approveUnloadRequestSchema,
  createNetworkRequestSchema,
  layLineRequestSchema,
  placeHoldRequestSchema,
  createDispatchPlanRequestSchema,
  selectBaselineFixRequestSchema,
  removeStationRequestSchema,
  repositoryFileQuerySchema,
  modelSettingsSchema,
  setNetworkModelSettingsRequestSchema,
  type ApiError,
  type EventsResponse,
} from "@terminus/protocol"
import type { z } from "zod"
import {
  SandboxCleanupError,
  stopStationSandbox,
} from "../integrations/sandbox-cleanup"
import {
  launchTrainPreview,
  PreviewError,
  stopTrainPreview,
} from "../integrations/train-preview"
import {
  launchTerminusPreview,
  stopTerminusPreview,
} from "../integrations/terminus-preview"
import {
  layCrossingDemoLines,
  layDemoLines,
  layJunctionDemo,
} from "../agents/demo-network"
import {
  clearTrain,
  createNetwork,
  DispatchError,
  layLine,
  placeHold,
  releaseHold,
  resolveConflict,
  retryIntegration,
  removeStation,
} from "../agents/dispatcher"
import { dispatcherPorts, dispatchPlanningPorts } from "../agents/ports"
import {
  proposeDispatchPlan,
  selectPlanBaselineFix,
  launchPlannedLines,
  retryDispatchPlan,
} from "../agents/dispatch-planning"

type Handler = (
  request: Request,
  env: Env,
  params: Record<string, string>
) => Promise<Response>

const routes: [method: string, pattern: URLPattern, handler: Handler][] = [
  [
    "POST",
    new URLPattern({ pathname: "/api/networks/:networkId/emergency-brake" }),
    async (request, env, { networkId }) => {
      await parse(request, emergencyBrakeRequestSchema)
      return json(await emergencyBrake(env, networkId!))
    },
  ],
  [
    "DELETE",
    new URLPattern({ pathname: "/api/stations/:stationId/sandbox" }),
    async (request, env, { stationId }) => {
      await stopStationSandbox(
        env,
        stationId!,
        await parse(request, stopStationSandboxRequestSchema)
      )
      return new Response(null, { status: 204 })
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/networks/:networkId/demo/junctions" }),
    async (request, env, { networkId }) => {
      const query = new URL(request.url).searchParams
      const models = await networkModels(env, networkId!)
      return json(
        await layJunctionDemo(
          junctionDispatchPorts(env, models),
          networkId!,
          models.conductor,
          {
            direct: query.get("direct") === "true",
            crossing: query.get("crossing") === "true",
          }
        ),
        201
      )
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/networks/:networkId/junctions" }),
    async (request, env, { networkId }) => {
      const models = await networkModels(env, networkId!)
      return json(
        await layJunction(
          junctionDispatchPorts(env, models),
          networkId!,
          await parse(request, createJunctionRequestSchema),
          models.conductor
        ),
        201
      )
    },
  ],
  [
    "GET",
    new URLPattern({ pathname: "/api/junctions/:junctionId" }),
    async (_, env, { junctionId }) => {
      const store = dispatcherPorts(env).store,
        j = await store.junction(junctionId!)
      if (!j) return notFound("Unknown Junction")
      const snapshot = await store.snapshot(j.networkId)
      return json({
        junction: j.value,
        attempts: (await store.integrations(j.networkId)).filter(
          (a) => a.input.junctionId === junctionId
        ),
        repairs: (await store.repairs(j.networkId)).filter(
          (r) => r.source.junctionId === junctionId
        ),
        cars:
          snapshot?.cars.filter(
            (c) =>
              j.value.inputs.some((i) => i.carIds.includes(c.id)) ||
              c.junctionId === junctionId
          ) ?? [],
      })
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/junctions/:junctionId/release" }),
    async (request, env, { junctionId }) => {
      const ports = junctionDispatchPorts(env),
        body = await parse(request, releaseJunctionRequestSchema)
      const j = await ports.store.junction(junctionId!)
      if (!j) return notFound("Unknown Junction")
      try {
        await ports.store.commandJunction(junctionId!, body)
      } catch {
        throw new DispatchError(
          409,
          "Release requires the exact accepted Junction commit"
        )
      }
      await ports.wakeJunction(junctionId!).catch(() => {})
      return json({ ok: true }, 202)
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/junctions/:junctionId/retry" }),
    async (_, env, { junctionId }) => {
      const ports = junctionDispatchPorts(env),
        j = await ports.store.junction(junctionId!)
      if (!j) return notFound("Unknown Junction")
      if (j.value.state.status === "abandoned")
        throw new DispatchError(409, "Junction is abandoned")
      if (j.value.state.status !== "blocked") return json({ ok: true }, 202)
      for (const a of await ports.store.integrations(j.networkId))
        if (
          a.input.junctionId === junctionId &&
          ["cleared", "prepared"].includes(a.status) &&
          a.result
        ) {
          const workflow = await env.INTEGRATION_WORKFLOW.get(a.input.id)
          if ((await workflow.status()).status !== "errored")
            throw new DispatchError(
              409,
              "Wait for the interrupted integration to stop before retrying"
            )
          await ports.store.retryIntegration(a.input.id)
        }
      await ports.store.commandJunction(junctionId!, { retry: true })
      await ports.wakeJunction(junctionId!).catch(() => {})
      return json({ ok: true }, 202)
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/junctions/:junctionId/abandon" }),
    async (request, env, { junctionId }) => {
      const ports = junctionDispatchPorts(env),
        j = await ports.store.junction(junctionId!)
      if (!j) return notFound("Unknown Junction")
      if (j.value.state.status === "released")
        throw new DispatchError(409, "Junction already released")
      const { reason } = await parse(request, removeStationRequestSchema)
      await ports.store.commandJunction(junctionId!, { reason })
      await ports.wakeJunction(junctionId!).catch(() => {})
      return json({ ok: true }, 202)
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/junctions/:junctionId/repairs" }),
    async (request, env, { junctionId }) => {
      const j = await dispatcherPorts(env).store.junction(junctionId!)
      if (!j) return notFound("Unknown Junction")
      return json(
        await dispatchJunctionRepair(
          technicianPorts(env, await networkModels(env, j.networkId)),
          junctionId!,
          await parse(request, junctionRepairRequestSchema)
        ),
        202
      )
    },
  ],
  [
    "POST",
    new URLPattern({
      pathname: "/api/junctions/:junctionId/repairs/:repairId/approve",
    }),
    async (request, env, { junctionId, repairId }) => {
      const j = await dispatcherPorts(env).store.junction(junctionId!)
      if (!j) return notFound("Unknown Junction")
      const repair = await approveJunctionRepair(
        technicianPorts(env, await networkModels(env, j.networkId)),
        repairId!,
        junctionId!,
        (await parse(request, releaseJunctionRequestSchema)).commit
      )
      await junctionDispatchPorts(env)
        .wakeJunction(junctionId!)
        .catch(() => {})
      return json(repair, 202)
    },
  ],
  [
    "GET",
    new URLPattern({ pathname: "/api/junctions/:junctionId/repository" }),
    async (_, env, { junctionId }) => {
      const ports = dispatcherPorts(env),
        j = await ports.store.junction(junctionId!)
      return j
        ? json(
            await ports.repositories.readOverview(
              j.value.repoId,
              j.value.headCommit
            )
          )
        : notFound("Unknown Junction")
    },
  ],
  [
    "GET",
    new URLPattern({ pathname: "/api/junctions/:junctionId/repository/file" }),
    async (request, env, { junctionId }) => {
      const ports = dispatcherPorts(env),
        j = await ports.store.junction(junctionId!)
      if (!j) return notFound("Unknown Junction")
      const query = repositoryFileQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams)
      )
      if (!query.success) return error(400, "commit and path are required")
      const file = await ports.repositories.readFile(
        j.value.repoId,
        query.data.commit,
        query.data.path
      )
      return file ? commitAddressed(file, true) : notFound("No such file")
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/networks/:networkId/demo/crossings" }),
    async (_, env, { networkId }) => {
      await layCrossingDemoLines(dispatcherPorts(env), networkId!)
      return json({ ok: true })
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/trains/:trainId/siding" }),
    async (request, env, { trainId }) => {
      const ports = dispatcherPorts(env),
        train = await ports.store.train(trainId!)
      if (!train) return notFound("Unknown Train")
      if (train.value.state.status === "siding") return json({ ok: true })
      if (
        !["ready", "held", "blocked"].includes(train.value.state.status) &&
        !(
          train.value.state.status === "returning" &&
          train.value.state.phase === "awaiting_clearance"
        )
      )
        throw new DispatchError(409, "Train must be stopped at a gate")
      const { reason } = await parse(request, removeStationRequestSchema)
      if (!(await ports.store.requestSiding(trainId!, reason)))
        throw new DispatchError(409, "Train has an unresolved promotion")
      await ports.notifyTrainCommand(trainId!).catch(() => {})
      return json({ ok: true })
    },
  ],
  [
    "GET",
    new URLPattern({ pathname: "/api/crossings/:crossingId" }),
    async (_, env, { crossingId }) => {
      const store = dispatcherPorts(env).store,
        crossing = await store.crossing(crossingId!)
      if (!crossing) return notFound("Unknown Crossing")
      const snapshot = await store.snapshot(crossing.networkId)
      const checkpoint =
        crossing.value.checkpoint ??
        (await store.checkpoint(crossing.value.sourceStationId))
      return json({
        crossing: crossing.value,
        checkpoint,
        attempts: await store.crossingAttempts(crossingId!),
        cars:
          snapshot?.cars.filter(
            (c) =>
              checkpoint?.carIds.includes(c.id) || c.crossingId === crossingId
          ) ?? [],
      })
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/crossings/:crossingId/retry" }),
    async (_, env, { crossingId }) => {
      const ports = dispatcherPorts(env),
        loaded = await ports.store.crossing(crossingId!)
      if (!loaded) return notFound("Unknown Crossing")
      if (loaded.value.state.status !== "blocked")
        throw new DispatchError(409, "Crossing is not blocked")
      if (!loaded.value.retryRequested)
        await ports.store.commit(
          loaded.networkId,
          [
            {
              kind: "crossing",
              crossing: { ...loaded.value, retryRequested: true },
              version: loaded.version,
            },
          ],
          []
        )
      const active = (await ports.store.crossingAttempts(crossingId!)).find(
        (a) => a.status === "cleared" || a.status === "prepared"
      )
      if (active?.result) await ports.retryIntegration(active.input.id)
      const train = (await ports.store.trains(loaded.networkId)).find(
        (t) => t.value.lineId === loaded.value.lineId
      )
      if (train) await ports.notifyTrainCommand(train.value.id)
      return json({ ok: true })
    },
  ],
  [
    "GET",
    new URLPattern({ pathname: "/api/settings/models" }),
    async (_, env) =>
      json({
        ...(await dispatcherPorts(env).store.generalModelSettings()),
        alternativeHarnessesEnabled: alternativeHarnessesEnabled(env),
      }),
  ],
  [
    "PUT",
    new URLPattern({ pathname: "/api/settings/models" }),
    async (request, env) => {
      const settings = await parse(request, modelSettingsSchema)
      if (unavailableHarnessSettings(env, settings))
        throw new DispatchError(
          409,
          "Alternative harnesses and providers require live Sandbox verification before enablement"
        )
      const { store, now } = dispatcherPorts(env)
      return json({
        ...(await store.setGeneralModelSettings(settings, now())),
        alternativeHarnessesEnabled: alternativeHarnessesEnabled(env),
      })
    },
  ],
  [
    "GET",
    new URLPattern({ pathname: "/api/networks/:networkId/settings/models" }),
    async (_, env, { networkId }) => {
      const { store } = dispatcherPorts(env)
      if (!(await store.network(networkId!))) return notFound("Unknown network")
      return json({
        ...(await store.networkModelSettings(networkId!)),
        alternativeHarnessesEnabled: alternativeHarnessesEnabled(env),
      })
    },
  ],
  [
    "PUT",
    new URLPattern({ pathname: "/api/networks/:networkId/settings/models" }),
    async (request, env, { networkId }) => {
      const { override } = await parse(
        request,
        setNetworkModelSettingsRequestSchema
      )
      const { store, now } = dispatcherPorts(env)
      if (!(await store.network(networkId!))) return notFound("Unknown network")
      if (unavailableHarnessSettings(env, override))
        throw new DispatchError(
          409,
          "Alternative harnesses and providers require live Sandbox verification before enablement"
        )
      return json({
        ...(await store.setNetworkModelSettings(networkId!, override, now())),
        alternativeHarnessesEnabled: alternativeHarnessesEnabled(env),
      })
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/networks/:networkId/preview" }),
    async (request, env, { networkId }) => {
      const { commit } = await parse(request, terminusPreviewRequestSchema)
      const preview = await launchTerminusPreview(
        request,
        env,
        networkId!,
        commit
      )
      return Response.json(preview, {
        headers: { "cache-control": "no-store" },
      })
    },
  ],
  [
    "DELETE",
    new URLPattern({ pathname: "/api/networks/:networkId/preview" }),
    async (request, env, { networkId }) => {
      const { commit } = await parse(request, stopPreviewRequestSchema)
      await stopTerminusPreview(env, networkId!, commit)
      return new Response(null, { status: 204 })
    },
  ],
  [
    "PUT",
    new URLPattern({ pathname: "/api/trains/:trainId/unload-mode" }),
    async (request, env, { trainId }) =>
      json(
        await updateTrainUnload(
          dispatcherPorts(env),
          trainId!,
          await parse(request, setUnloadModeRequestSchema)
        )
      ),
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/trains/:trainId/approve-unload" }),
    async (request, env, { trainId }) =>
      json(
        await updateTrainUnload(
          dispatcherPorts(env),
          trainId!,
          await parse(request, approveUnloadRequestSchema)
        )
      ),
  ],
  [
    "PUT",
    new URLPattern({
      pathname:
        "/api/networks/:networkId/plans/:planId/lines/:lineKey/unload-mode",
    }),
    async (request, env, { networkId, planId, lineKey }) => {
      const body = await parse(request, setUnloadModeRequestSchema)
      return json(
        await selectPlanUnloadMode(
          dispatcherPorts(env),
          networkId!,
          planId!,
          lineKey!,
          body.mode
        )
      )
    },
  ],
  [
    "POST",
    new URLPattern({
      pathname: "/api/networks/:networkId/conflicts/:conflictId/technician",
    }),
    async (_, env, { networkId, conflictId }) =>
      json(
        await dispatchTechnician(
          technicianPorts(env, await networkModels(env, networkId!)),
          networkId!,
          conflictId!
        ),
        202
      ),
  ],
  [
    "POST",
    new URLPattern({
      pathname: "/api/networks/:networkId/repairs/:repairId/approve",
    }),
    async (_, env, { networkId, repairId }) =>
      json(
        await approveTechnician(
          technicianPorts(env, await networkModels(env, networkId!)),
          networkId!,
          repairId!
        ),
        202
      ),
  ],

  [
    "POST",
    new URLPattern({
      pathname: "/api/networks/:networkId/stations/:stationId/remove",
    }),
    async (request, env, { networkId, stationId }) => {
      const body = await parse(request, removeStationRequestSchema)
      await removeStation(dispatcherPorts(env), networkId!, stationId!, body)
      return new Response(null, { status: 202 })
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/trains/:trainId/preview" }),
    async (request, env, { trainId }) => {
      const preview = await launchTrainPreview(request, env, trainId!)
      return Response.json(preview, {
        headers: { "cache-control": "no-store" },
      })
    },
  ],
  [
    "DELETE",
    new URLPattern({ pathname: "/api/trains/:trainId/preview" }),
    async (request, env, { trainId }) => {
      const { commit } = await parse(request, stopPreviewRequestSchema)
      await stopTrainPreview(env, trainId!, commit)
      return new Response(null, { status: 204 })
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/networks/:networkId/plans" }),
    async (request, env, { networkId }) => {
      const body = await parse(request, createDispatchPlanRequestSchema)
      return json(
        await proposeDispatchPlan(
          dispatchPlanningPorts(env, await networkModels(env, networkId!)),
          networkId!,
          body
        ),
        202
      )
    },
  ],
  [
    "PUT",
    new URLPattern({
      pathname: "/api/networks/:networkId/plans/:planId/baseline-fix",
    }),
    async (request, env, { networkId, planId }) => {
      const body = await parse(request, selectBaselineFixRequestSchema)
      return json(
        await selectPlanBaselineFix(
          dispatcherPorts(env),
          networkId!,
          planId!,
          body.selection
        )
      )
    },
  ],
  [
    "POST",
    new URLPattern({
      pathname: "/api/networks/:networkId/plans/:planId/launch",
    }),
    async (_, env, { networkId, planId }) =>
      json(
        await launchPlannedLines(
          dispatchPlanningPorts(env, await networkModels(env, networkId!)),
          networkId!,
          planId!
        ),
        202
      ),
  ],
  [
    "POST",
    new URLPattern({
      pathname: "/api/networks/:networkId/plans/:planId/retry",
    }),
    async (_, env, { networkId, planId }) => {
      await retryDispatchPlan(
        dispatchPlanningPorts(env, await networkModels(env, networkId!)),
        networkId!,
        planId!
      )
      return new Response(null, { status: 202 })
    },
  ],
  [
    "GET",
    new URLPattern({ pathname: "/api/networks/:networkId/integrations" }),
    async (_, env, { networkId }) => {
      const { store } = dispatcherPorts(env)
      if (!(await store.network(networkId!))) return notFound("Unknown network")
      return json(await store.integrations(networkId!))
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/integrations/:integrationId/retry" }),
    async (_, env, { integrationId }) => {
      await retryIntegration(dispatcherPorts(env), integrationId!)
      return new Response(null, { status: 202 })
    },
  ],
  [
    "POST",
    new URLPattern({
      pathname: "/api/networks/:networkId/conflicts/:conflictId/resolve",
    }),
    async (_, env, { networkId, conflictId }) => {
      await resolveConflict(dispatcherPorts(env), networkId!, conflictId!)
      return new Response(null, { status: 204 })
    },
  ],
  [
    "GET",
    new URLPattern({ pathname: "/api/networks" }),
    async (_, env) => json(await dispatcherPorts(env).store.networkListings()),
  ],
  [
    "GET",
    new URLPattern({ pathname: "/api/networks/:networkId/summary" }),
    async (_, env, { networkId }) => {
      const [listing] = await dispatcherPorts(env).store.networkListings(
        networkId!
      )
      return listing ? json(listing) : notFound("Unknown network")
    },
  ],
  [
    "GET",
    new URLPattern({ pathname: "/api/networks/:networkId/repository" }),
    async (request, env, { networkId }) => {
      const { store, repositories } = dispatcherPorts(env)
      const network = await store.network(networkId!)
      if (!network) return notFound("Unknown network")
      const requested = new URL(request.url).searchParams.get("commit")
      const overview = await repositories.readOverview(
        network.terminusRepoId,
        requested ?? network.terminusCommit
      )
      return commitAddressed(overview, requested !== null)
    },
  ],
  [
    "GET",
    new URLPattern({ pathname: "/api/networks/:networkId/repository/file" }),
    async (request, env, { networkId }) => {
      const { store, repositories } = dispatcherPorts(env)
      const network = await store.network(networkId!)
      if (!network) return notFound("Unknown network")
      const query = repositoryFileQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams)
      )
      if (!query.success)
        return error(
          400,
          "`commit` and `path` are required",
          query.error.issues
        )
      const file = await repositories.readFile(
        network.terminusRepoId,
        query.data.commit,
        query.data.path
      )
      return file ? commitAddressed(file, true) : notFound("No such file")
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/networks" }),
    async (request, env) => {
      const body = await parse(request, createNetworkRequestSchema)
      return json(await createNetwork(dispatcherPorts(env), body), 201)
    },
  ],
  [
    "GET",
    new URLPattern({ pathname: "/api/networks/:networkId" }),
    async (_, env, { networkId }) => {
      const snapshot = await dispatcherPorts(env).store.snapshot(networkId!)
      return snapshot ? json(snapshot) : notFound(`Unknown network`)
    },
  ],
  [
    "GET",
    new URLPattern({ pathname: "/api/networks/:networkId/events" }),
    async (request, env, { networkId }) => {
      const after = Number(new URL(request.url).searchParams.get("after") ?? 0)
      if (!Number.isInteger(after) || after < 0) {
        return error(400, "`after` must be a non-negative integer")
      }
      const { store } = dispatcherPorts(env)
      const events = await store.eventsAfter(networkId!, after)
      const body: EventsResponse = {
        events,
        lastSeq: events.at(-1)?.seq ?? after,
      }
      return json(body)
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/networks/:networkId/lines" }),
    async (request, env, { networkId }) => {
      const body = await parse(request, layLineRequestSchema)
      return json(await layLine(dispatcherPorts(env), networkId!, body), 201)
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/networks/:networkId/demo" }),
    async (_, env, { networkId }) => {
      await layDemoLines(dispatcherPorts(env), networkId!)
      return new Response(null, { status: 204 })
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/networks/:networkId/holds" }),
    async (request, env, { networkId }) => {
      const body = await parse(request, placeHoldRequestSchema)
      return json(await placeHold(dispatcherPorts(env), networkId!, body), 201)
    },
  ],
  [
    "DELETE",
    new URLPattern({ pathname: "/api/networks/:networkId/holds/:holdId" }),
    async (_, env, { networkId, holdId }) => {
      await releaseHold(dispatcherPorts(env), networkId!, holdId!)
      return new Response(null, { status: 204 })
    },
  ],
  [
    "POST",
    new URLPattern({ pathname: "/api/trains/:trainId/clear" }),
    async (_, env, { trainId }) => {
      await clearTrain(dispatcherPorts(env), trainId!)
      return new Response(null, { status: 202 })
    },
  ],
]

export async function handleApi(request: Request, env: Env): Promise<Response> {
  for (const [method, pattern, handler] of routes) {
    const match = pattern.exec(request.url)
    if (!match) continue
    if (request.method !== method) continue
    try {
      return await handler(
        request,
        env,
        match.pathname.groups as Record<string, string>
      )
    } catch (caught) {
      if (caught instanceof RequestError)
        return error(400, caught.message, caught.details)
      if (caught instanceof DispatchError)
        return error(caught.status, caught.message, caught.details)
      if (caught instanceof PreviewError)
        return error(caught.status, caught.message)
      if (caught instanceof SandboxCleanupError)
        return error(caught.status, caught.message)
      throw caught
    }
  }
  return notFound("No such route")
}

class RequestError extends Error {
  readonly details: unknown

  constructor(message: string, details?: unknown) {
    super(message)
    this.details = details
  }
}

async function parse<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<z.infer<T>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new RequestError("The request body must be JSON")
  }
  const result = schema.safeParse(body)
  if (!result.success) {
    throw new RequestError("The request body is invalid", result.error.issues)
  }
  return result.data
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

/** A commit's contents never change, so a read pinned to one may be cached. */
function commitAddressed(body: unknown, pinned: boolean): Response {
  return Response.json(body, {
    headers: {
      "cache-control": pinned
        ? "private, max-age=86400, immutable"
        : "no-store",
    },
  })
}

function error(status: number, message: string, details?: unknown): Response {
  const body: ApiError = { error: message, details }
  return json(body, status)
}

function notFound(message: string): Response {
  return error(404, message)
}
