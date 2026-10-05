import {
  junctionDetailsSchema,
  junctionSchema,
  type CreateJunctionRequest,
  type Junction,
  crossingDetailsSchema,
  technicianRepairSchema,
  eventsResponseSchema,
  dispatchPlanSchema,
  trainPreviewSchema,
  terminusPreviewSchema,
  trainUnloadPolicySchema,
  type UnloadMode,
  type CreateDispatchPlanRequest,
  type ApiError,
  type EventsResponse,
  type Hold,
  type NetworkListing,
  type NetworkSnapshot,
  type NetworkSummary,
  repositoryFileSchema,
  repositoryOverviewSchema,
  generalModelSettingsSchema,
  networkModelSettingsSchema,
  type ModelSettings,
  type PlaceHoldRequest,
} from "@terminus/protocol"

/** Application-level commands and queries against the Worker API. */
export const api = {
  layJunctionDemo: (id: string) =>
    request(`/networks/${id}/demo/junctions`, { method: "POST" }),
  createJunction: async (
    networkId: string,
    body: CreateJunctionRequest
  ): Promise<Junction> =>
    junctionSchema.parse(
      await request(`/networks/${networkId}/junctions`, {
        method: "POST",
        body,
      })
    ),
  junction: async (id: string) =>
    junctionDetailsSchema.parse(
      await request(`/junctions/${encodeURIComponent(id)}`)
    ),
  releaseJunction: (id: string, commit: string) =>
    request(`/junctions/${encodeURIComponent(id)}/release`, {
      method: "POST",
      body: { commit },
    }),
  retryJunction: (id: string) =>
    request(`/junctions/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  abandonJunction: (id: string, reason: string) =>
    request(`/junctions/${encodeURIComponent(id)}/abandon`, {
      method: "POST",
      body: { reason },
    }),
  dispatchJunctionRepair: (
    id: string,
    body: { failureId: string; scope?: string[] }
  ) =>
    request(`/junctions/${encodeURIComponent(id)}/repairs`, {
      method: "POST",
      body,
    }),
  approveJunctionRepair: (id: string, repairId: string, commit: string) =>
    request(
      `/junctions/${encodeURIComponent(id)}/repairs/${encodeURIComponent(repairId)}/approve`,
      { method: "POST", body: { commit } }
    ),
  junctionRepository: async (id: string) =>
    repositoryOverviewSchema.parse(
      await request(`/junctions/${encodeURIComponent(id)}/repository`)
    ),
  junctionFile: async (id: string, commit: string, path: string) =>
    repositoryFileSchema.parse(
      await request(
        `/junctions/${encodeURIComponent(id)}/repository/file?${new URLSearchParams({ commit, path })}`
      )
    ),
  sideTrain: (id: string, reason: string) =>
    request(`/trains/${encodeURIComponent(id)}/siding`, {
      method: "POST",
      body: { reason },
    }),
  crossing: async (id: string) =>
    crossingDetailsSchema.parse(
      await request(`/crossings/${encodeURIComponent(id)}`)
    ),
  retryCrossing: (id: string) =>
    request(`/crossings/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  networks: () => request<NetworkListing[]>("/networks"),
  networkSummary: (networkId: string) =>
    request<NetworkListing>(`/networks/${networkId}/summary`),
  /** Pinned to a commit, so the browser may cache it. */
  repositoryOverview: async (networkId: string, commit: string) =>
    repositoryOverviewSchema.parse(
      await request(
        `/networks/${networkId}/repository?commit=${encodeURIComponent(commit)}`
      )
    ),
  repositoryFile: async (networkId: string, commit: string, path: string) =>
    repositoryFileSchema.parse(
      await request(
        `/networks/${networkId}/repository/file?${new URLSearchParams({ commit, path })}`
      )
    ),
  modelSettings: async () =>
    generalModelSettingsSchema.parse(await request("/settings/models")),
  saveModelSettings: async (settings: ModelSettings) =>
    generalModelSettingsSchema.parse(
      await request("/settings/models", { method: "PUT", body: settings })
    ),
  networkModelSettings: async (networkId: string) =>
    networkModelSettingsSchema.parse(
      await request(`/networks/${networkId}/settings/models`)
    ),
  /** Null removes the network's override so it follows General again. */
  saveNetworkModelSettings: async (
    networkId: string,
    override: ModelSettings | null
  ) =>
    networkModelSettingsSchema.parse(
      await request(`/networks/${networkId}/settings/models`, {
        method: "PUT",
        body: { override },
      })
    ),
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
  layCrossingDemoLines: (id: string) =>
    request(`/networks/${id}/demo/crossings`, { method: "POST" }),
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
  selectPlanUnloadMode: async (
    networkId: string,
    planId: string,
    lineKey: string,
    mode: UnloadMode
  ) =>
    dispatchPlanSchema.parse(
      await request(
        `/networks/${networkId}/plans/${planId}/lines/${lineKey}/unload-mode`,
        { method: "PUT", body: { mode } }
      )
    ),
  setTrainUnloadMode: async (trainId: string, mode: UnloadMode) =>
    trainUnloadPolicySchema.parse(
      await request(`/trains/${trainId}/unload-mode`, {
        method: "PUT",
        body: { mode },
      })
    ),
  approveTrainUnload: async (trainId: string, trainCommit: string) =>
    trainUnloadPolicySchema.parse(
      await request(`/trains/${trainId}/approve-unload`, {
        method: "POST",
        body: { trainCommit },
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
  dispatchTechnician: async (networkId: string, conflictId: string) =>
    technicianRepairSchema.parse(
      await request(
        `/networks/${networkId}/conflicts/${conflictId}/technician`,
        { method: "POST" }
      )
    ),
  approveRepair: async (networkId: string, repairId: string) =>
    technicianRepairSchema.parse(
      await request(`/networks/${networkId}/repairs/${repairId}/approve`, {
        method: "POST",
      })
    ),
  clearTrain: (trainId: string) =>
    request<void>(`/trains/${trainId}/clear`, { method: "POST" }),
  removeStation: (networkId: string, stationId: string, reason: string) =>
    request<void>(`/networks/${networkId}/stations/${stationId}/remove`, {
      method: "POST",
      body: { reason },
    }),
  previewTrain: async (trainId: string) =>
    trainPreviewSchema.parse(
      await request(`/trains/${trainId}/preview`, { method: "POST" })
    ),
  previewTerminus: async (networkId: string, commit: string) =>
    terminusPreviewSchema.parse(
      await request(`/networks/${networkId}/preview`, {
        method: "POST",
        body: { commit },
      })
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
