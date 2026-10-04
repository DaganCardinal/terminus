import {
  eventsResponseSchema,
  dispatchPlanSchema,
  trainPreviewSchema,
  type CreateDispatchPlanRequest,
  type ApiError,
  type EventsResponse,
  type Hold,
  type NetworkSnapshot,
  type NetworkSummary,
  type PlaceHoldRequest,
} from "@terminus/protocol"

/** Application-level commands and queries against the Worker API. */
export const api = {
  networks: () => request<NetworkSummary[]>("/networks"),
  createNetwork: (name: string, sourceUrl?: string) =>
    request<NetworkSummary>("/networks", {
      method: "POST",
      body: { name, ...(sourceUrl ? { sourceUrl } : {}) },
    }),
  snapshot: (networkId: string) =>
    request<NetworkSnapshot>(`/networks/${networkId}`),
  events: async (networkId: string, after: number): Promise<EventsResponse> =>
    eventsResponseSchema.parse(
      await request(`/networks/${networkId}/events?after=${after}`)
    ),
  layDemoLines: (networkId: string) =>
    request<void>(`/networks/${networkId}/demo`, { method: "POST" }),
  proposePlan: async (networkId: string, body: CreateDispatchPlanRequest) =>
    dispatchPlanSchema.parse(
      await request(`/networks/${networkId}/plans`, { method: "POST", body })
    ),
  launchPlan: async (networkId: string, planId: string) =>
    dispatchPlanSchema.parse(
      await request(`/networks/${networkId}/plans/${planId}/launch`, {
        method: "POST",
      })
    ),
  retryPlan: (networkId: string, planId: string) =>
    request<void>(`/networks/${networkId}/plans/${planId}/retry`, {
      method: "POST",
    }),
  placeHold: (networkId: string, hold: PlaceHoldRequest) =>
    request<Hold>(`/networks/${networkId}/holds`, {
      method: "POST",
      body: hold,
    }),
  releaseHold: (networkId: string, holdId: string) =>
    request<void>(`/networks/${networkId}/holds/${holdId}`, {
      method: "DELETE",
    }),
  clearTrain: (trainId: string) =>
    request<void>(`/trains/${trainId}/clear`, { method: "POST" }),
  previewTrain: async (trainId: string) =>
    trainPreviewSchema.parse(
      await request(`/trains/${trainId}/preview`, { method: "POST" })
    ),
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers:
      init.body === undefined
        ? undefined
        : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiError | null
    throw new Error(body?.error ?? `Request failed (${response.status})`)
  }
  if (response.status === 204) {
    return undefined as T
  }
  if (response.status === 202) {
    const body = await response.text()
    return body ? (JSON.parse(body) as T) : (undefined as T)
  }
  return (await response.json()) as T
}
