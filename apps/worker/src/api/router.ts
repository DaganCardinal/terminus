import {
  createNetworkRequestSchema,
  layLineRequestSchema,
  placeHoldRequestSchema,
  type ApiError,
  type EventsResponse,
} from "@terminus/protocol"
import type { z } from "zod"
import { layDemoLines } from "../agents/demo-network"
import {
  clearTrain,
  createNetwork,
  DispatchError,
  layLine,
  placeHold,
  releaseHold,
} from "../agents/dispatcher"
import { dispatcherPorts } from "../agents/ports"

type Handler = (
  request: Request,
  env: Env,
  params: Record<string, string>
) => Promise<Response>

const routes: [method: string, pattern: URLPattern, handler: Handler][] = [
  [
    "GET",
    new URLPattern({ pathname: "/api/networks" }),
    async (_, env) => json(await dispatcherPorts(env).store.networks()),
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

function error(status: number, message: string, details?: unknown): Response {
  const body: ApiError = { error: message, details }
  return json(body, status)
}

function notFound(message: string): Response {
  return error(404, message)
}
