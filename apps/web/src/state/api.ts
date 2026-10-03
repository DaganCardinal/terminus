import {
  eventsResponseSchema,
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
  if (response.status === 202 || response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}
