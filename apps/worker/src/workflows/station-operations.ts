import type { StationRunner, StationRunResult } from "@terminus/agent-runtime"
import type { RepositoryHost } from "@terminus/artifacts"
import { recordWorkspace, startStation } from "@terminus/domain"
import type { NetworkStore } from "../integrations/network-store"
import type { StationRunParams } from "./train-operations"
import { applied } from "./transitions"

export interface StationPorts {
  store: NetworkStore
  repositories: RepositoryHost
  runner: StationRunner
}

/**
 * Forks the Station's workspace from the Train's latest commit and starts the
 * Station. Revisions reuse the existing workspace, so there is nothing to do.
 */
export async function prepareStation(
  ports: StationPorts,
  params: StationRunParams
): Promise<void> {
  const train = await ports.store.train(params.trainId)
  let station = await ports.store.station(params.stationId)
  if (!train || !station) throw new Error(`Unknown run ${params.runId}`)
  if (station.value.state.status !== "signaled") return

  if (station.value.state.workspace === null) {
    const fork = await ports.repositories.fork({
      sourceRepoId: train.value.repoId,
      commit: train.value.headCommit,
      name: params.runId,
    })
    const recorded = applied(
      recordWorkspace({
        train: train.value,
        station: station.value,
        workspace: { repoId: fork.repoId, baseCommit: train.value.headCommit },
      })
    )
    await ports.store.commit(
      station.networkId,
      [{ kind: "station", station: recorded.value, version: station.version }],
      recorded.events
    )
    station = {
      ...station,
      value: recorded.value,
      version: station.version + 1,
    }
  }

  const started = applied(startStation(station.value))
  await ports.store.commit(
    station.networkId,
    [{ kind: "station", station: started.value, version: station.version }],
    started.events
  )
}

/** Runs the Station Agent on the manifest, with any Conductor feedback. */
export async function runStationAgent(
  ports: StationPorts,
  params: StationRunParams
): Promise<StationRunResult> {
  const station = await ports.store.station(params.stationId)
  if (!station) throw new Error(`Unknown Station ${params.stationId}`)
  const { state } = station.value
  if (state.status !== "active" && state.status !== "revising") {
    throw new Error(
      `Station ${params.stationId} cannot run while ${state.status}`
    )
  }
  const network = await ports.store.network(station.networkId)
  if (!network) throw new Error(`Unknown network ${station.networkId}`)
  return ports.runner.run({
    stationId: station.value.id,
    runId: params.runId,
    manifest: station.value.manifest,
    workspace: state.workspace,
    feedback: state.status === "revising" ? state.feedback : null,
    validation: network.validation,
  })
}
