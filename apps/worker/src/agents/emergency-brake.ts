import {
  placeHold,
  requestStationStop,
  type DomainEvent,
} from "@terminus/domain"
import type { EmergencyBrakeResult, EventEnvelope } from "@terminus/protocol"
import {
  StaleWriteError,
  NetworkStore,
  type Write,
} from "../integrations/network-store"
import {
  stationRunHistory,
  type StationRunReference,
} from "../integrations/station-run-history"
import { applied } from "../workflows/transitions"
import { TRAIN_EVENTS } from "../workflows/events"
import { DispatchError } from "./dispatcher"

const reason =
  "Emergency Brake pulled by the user. Unfinished Station work was discarded."

export interface EmergencyBrakePorts {
  store: NetworkStore
  stopRun(run: StationRunReference): Promise<void>
  notifyTrain(run: StationRunReference): Promise<void>
}

/** The Dispatcher records user intent; Train Workflows alone apply stop requests. */
export async function pullEmergencyBrake(
  ports: EmergencyBrakePorts,
  networkId: string
): Promise<EmergencyBrakeResult> {
  if (!(await ports.store.network(networkId)))
    throw new DispatchError(404, "Unknown network")
  const holdId = `emergency-brake-${networkId}`
  let stopping: Set<string> | undefined
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      stopping = await recordStopRequests(ports.store, networkId, holdId)
      break
    } catch (error) {
      if (!(error instanceof StaleWriteError)) throw error
    }
  }
  if (!stopping)
    throw new DispatchError(
      409,
      "Station state changed during Emergency Brake. Try again."
    )

  const history: EventEnvelope[] = []
  let after = 0
  for (;;) {
    const page = await ports.store.eventsAfter(networkId, after)
    history.push(...page)
    if (page.length < 500) break
    after = page.at(-1)!.seq
  }
  const runs = stationRunHistory(history)
  const current = new Map(runs.map((run) => [run.stationId, run]))
  const result: EmergencyBrakeResult = {
    holdId,
    cleanedUpRunIds: [],
    failures: [],
  }
  // Wake an awaiting Train with an outcome it can durably consume, even when
  // terminating its Station Workflow prevents normal reporting.
  for (const stationId of stopping) {
    const run = current.get(stationId)
    if (!run) continue
    try {
      await ports.notifyTrain(run)
    } catch {
      result.failures.push({
        runId: run.runId,
        detail:
          "Could not notify the Train of its interruption. Try Emergency Brake again.",
      })
    }
  }
  for (const run of runs) {
    try {
      await ports.stopRun(run)
      result.cleanedUpRunIds.push(run.runId)
    } catch {
      result.failures.push({
        runId: run.runId,
        detail:
          "Could not terminate or close this Station run. Try Emergency Brake again.",
      })
    }
  }
  return result
}

async function recordStopRequests(
  store: NetworkStore,
  networkId: string,
  holdId: string
): Promise<Set<string>> {
  const stations = await store.stations(networkId)
  const writes: Write[] = []
  const events: DomainEvent[] = []
  if (!(await store.holds(networkId)).some((hold) => hold.id === holdId)) {
    const held = applied(
      placeHold({
        id: holdId,
        kind: "user",
        scope: { kind: "network" },
        note: "Emergency Brake: release this hold after resolving the interrupted Station runs.",
      })
    )
    writes.push({ kind: "hold", hold: held.value })
    events.push(...held.events)
  }
  const stopping = new Set<string>()
  for (const station of stations) {
    if (station.value.state.status === "waiting") {
      // Fence departures that read the old hold list before this atomic batch.
      // Their Station version must become stale, so the Train rechecks its gate.
      writes.push({
        kind: "station",
        station: station.value,
        version: station.version,
      })
      continue
    }
    if (
      ["waiting", "blocked", "complete", "cancelled"].includes(
        station.value.state.status
      )
    )
      continue
    stopping.add(station.value.id)
    const stopped = applied(requestStationStop(station.value, reason))
    if (stopped.events.length) {
      writes.push({
        kind: "station",
        station: stopped.value,
        version: station.version,
      })
      events.push(...stopped.events)
    }
  }
  if (writes.length) await store.commit(networkId, writes, events)
  return stopping
}

export async function emergencyBrake(
  env: Env,
  networkId: string
): Promise<EmergencyBrakeResult> {
  return pullEmergencyBrake(
    {
      store: new NetworkStore(env.DB),
      stopRun: async (run) => {
        let instance: WorkflowInstance | undefined
        try {
          instance = await env.STATION_WORKFLOW.get(run.runId)
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/(?:instance\.not_found|instance (?:does not exist|not found))/i.test(
              error.message
            )
          )
            throw error
          // Old Workflow instances may have expired while their Sandboxes remain.
          // Durable stop requests already prevent new Station work from starting.
        }
        if (instance) {
          const status = (await instance.status()).status
          if (!["complete", "errored", "terminated"].includes(status)) {
            await instance.terminate()
            const stopped = (await instance.status()).status
            if (!["complete", "errored", "terminated"].includes(stopped))
              throw new Error("Station Workflow has not stopped")
          }
        }
        if (env.REPOSITORY_MODE !== "fake")
          await env.SANDBOX.getByName(`station-${run.runId}`).close()
      },
      notifyTrain: async (run) => {
        await (
          await env.TRAIN_WORKFLOW.get(run.trainId)
        ).sendEvent({
          type: TRAIN_EVENTS.stationOutcome,
          payload: {
            stationId: run.stationId,
            runId: run.runId,
            result: {
              ok: false,
              issues: [{ kind: "needs_user", detail: reason }],
            },
          },
        })
      },
    },
    networkId
  )
}
