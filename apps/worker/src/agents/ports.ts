import {
  FakeTechnicianRunner,
  FakeRepairConductor,
  ModelRepairConductor,
  FakeConductor,
  FakeStationRunner,
  GatewayModelProvider,
  ModelConductor,
  HarnessDispatcher,
  FakeDispatchPlanner,
  type Conductor,
  type ModelProvider,
  type StationRunner,
} from "@terminus/agent-runtime"
import {
  ArtifactsRepositoryHost,
  FakeRepositoryHost,
  type RepositoryHost,
} from "@terminus/artifacts"
import type { ModelRole } from "@terminus/protocol"
import { NetworkStore } from "../integrations/network-store"
import { SandboxWorkspaces } from "../integrations/sandbox-workspaces"
import { artifactsRepositories } from "../integrations/artifacts-repositories"
import { SandboxTechnicianRunner } from "../integrations/technician-runner"
import { SandboxDispatchSessions } from "../integrations/dispatch-session"
import type { TechnicianPorts } from "./technician"
import { SandboxStationRunner } from "../integrations/station-runner"
import {
  gatewayConfig,
  gatewayTransport,
  stationMaxRetries,
} from "../integrations/execution-config"
import type { JunctionDispatchPorts } from "./junctions"
import { TRAIN_EVENTS } from "../workflows/events"
import {
  FakeIntegrationValidator,
  SandboxIntegrationValidator,
} from "../integrations/integration-validator"
import type { IntegrationPorts } from "../workflows/integration-operations"
import type { StationPorts } from "../workflows/station-operations"
import type {
  StationRunParams,
  TrainPorts,
} from "../workflows/train-operations"
import { DispatchError, type DispatcherPorts } from "./dispatcher"
import type { DispatchPlanningPorts } from "./dispatch-planning"

/** A role configured as `fake` runs without a model. */
const FAKE = "fake"

/**
 * The model each role runs with for one piece of work. Resolved from the
 * network's settings when the work starts, or from what the work recorded.
 */
export type ConfiguredModels = Record<ModelRole, string>

/** The models a network's settings choose right now. */
export function networkModels(
  env: Env,
  networkId: string
): Promise<ConfiguredModels> {
  return new NetworkStore(env.DB).roleModels(networkId)
}

/** A Train and its Station runs use the models of the Train's network. */
export async function trainModels(
  env: Env,
  trainId: string
): Promise<ConfiguredModels> {
  const train = await new NetworkStore(env.DB).train(trainId)
  if (!train) throw new Error(`Unknown Train ${trainId}`)
  return networkModels(env, train.networkId)
}

/** A plan keeps the Dispatcher model it was proposed with. */
export async function planModels(
  env: Env,
  planId: string
): Promise<ConfiguredModels> {
  const plan = await new NetworkStore(env.DB).dispatchPlan(planId)
  if (!plan) throw new Error(`Unknown plan ${planId}`)
  return {
    ...(await networkModels(env, plan.networkId)),
    dispatcher: plan.value.model,
  }
}

/** A repair keeps the Technician model it was dispatched with. */
export async function repairModels(
  env: Env,
  repairId: string
): Promise<ConfiguredModels> {
  const repair = await new NetworkStore(env.DB).repair(repairId)
  if (!repair) throw new Error(`Unknown repair ${repairId}`)
  return {
    ...(await networkModels(env, repair.networkId)),
    technician: repair.value.agent.model,
  }
}

export function trainPorts(env: Env, models: ConfiguredModels): TrainPorts {
  return {
    store: new NetworkStore(env.DB),
    repositories: repositories(env),
    conductor: conductor(env, models.conductor),
    stationMaxRetries: stationMaxRetries(env),
    startStationRun: (params) => startStationRun(env, params),
    startIntegration: async (integrationId) => {
      try {
        await env.INTEGRATION_WORKFLOW.create({
          id: integrationId,
          params: { integrationId },
        })
      } catch (error) {
        await env.INTEGRATION_WORKFLOW.get(integrationId).catch(() => {
          throw error
        })
      }
    },
    wakeJunction: (id) => junctionDispatchPorts(env).wakeJunction(id),
    wakeTrain: (trainId) => wakeTrain(env, trainId),
    newId,
    now: () => new Date().toISOString(),
  }
}

export function integrationPorts(env: Env): IntegrationPorts {
  const host = repositories(env)
  return {
    conductorForTrain: async (id, model) =>
      conductor(env, model ?? (await trainModels(env, id)).conductor),
    store: new NetworkStore(env.DB),
    repositories: host,
    validator:
      host instanceof ArtifactsRepositoryHost
        ? new SandboxIntegrationValidator(host, new SandboxWorkspaces(env))
        : new FakeIntegrationValidator(),
  }
}

export function technicianPorts(
  env: Env,
  models: ConfiguredModels
): TechnicianPorts {
  const host = repositories(env)
  return {
    ...dispatcherPorts(env),
    repositories: host,
    runner:
      env.TECHNICIAN_MODEL === FAKE
        ? new FakeTechnicianRunner()
        : new SandboxTechnicianRunner(
            env,
            models.technician,
            artifactsRepositories(env)
          ),
    reviewer:
      env.CONDUCTOR_MODEL === FAKE
        ? new FakeRepairConductor()
        : new ModelRepairConductor(
            models.conductor,
            gatewayProvider(env, models.conductor)
          ),
    validator:
      host instanceof ArtifactsRepositoryHost
        ? new SandboxIntegrationValidator(host, new SandboxWorkspaces(env))
        : new FakeIntegrationValidator(),
    startRepair: async (repairId) => {
      try {
        await env.TECHNICIAN_WORKFLOW.create({
          id: repairId,
          params: { repairId },
        })
      } catch (error) {
        await env.TECHNICIAN_WORKFLOW.get(repairId).catch(() => {
          throw error
        })
      }
    },
  }
}

export function stationPorts(env: Env, models: ConfiguredModels): StationPorts {
  return {
    store: new NetworkStore(env.DB),
    repositories: repositories(env),
    runner: stationRunner(env, models.stationAgent),
  }
}

export function dispatcherPorts(env: Env): DispatcherPorts {
  return {
    store: new NetworkStore(env.DB),
    repositories: repositories(env),
    startTrain: async (trainId) => {
      try {
        await env.TRAIN_WORKFLOW.create({ id: trainId, params: { trainId } })
      } catch (error) {
        await env.TRAIN_WORKFLOW.get(trainId).catch(() => {
          throw error
        })
      }
    },
    wakeTrain: (trainId) => wakeTrain(env, trainId),
    clearTrain: async (trainId) => {
      const instance = await env.TRAIN_WORKFLOW.get(trainId)
      await instance.sendEvent({ type: TRAIN_EVENTS.clear, payload: {} })
    },
    notifyTrainCommand: async (trainId) => {
      const instance = await env.TRAIN_WORKFLOW.get(trainId)
      await Promise.allSettled([
        instance.sendEvent({ type: TRAIN_EVENTS.wake, payload: {} }),
        instance.sendEvent({
          type: TRAIN_EVENTS.clear,
          payload: { reevaluateOnly: true },
        }),
      ])
    },
    retryIntegration: async (integrationId) => {
      const instance = await env.INTEGRATION_WORKFLOW.get(integrationId)
      const status = await instance.status()
      if (status.status !== "errored")
        throw new DispatchError(
          409,
          "Only an errored integration Workflow can be retried"
        )
      const store = new NetworkStore(env.DB)
      const attempt = await store.integration(integrationId)
      if (!attempt) throw new DispatchError(404, "Unknown integration attempt")
      await store.retryIntegration(integrationId)
      const train = await store.train(attempt.input.trainId)
      if (train?.value.state.status === "blocked") {
        const workflow = await env.TRAIN_WORKFLOW.get(attempt.input.trainId)
        await workflow.sendEvent({ type: TRAIN_EVENTS.clear, payload: {} })
      }
      await instance.restart()
    },
    newId,
    now: () => new Date().toISOString(),
  }
}

export function dispatchPlanningPorts(
  env: Env,
  models: ConfiguredModels
): DispatchPlanningPorts {
  return {
    ...dispatcherPorts(env),
    startJunction: (id) => junctionDispatchPorts(env).startJunction(id),
    planner:
      env.DISPATCHER_MODEL === FAKE
        ? new FakeDispatchPlanner()
        : new HarnessDispatcher(
            models.dispatcher,
            new SandboxDispatchSessions(env, artifactsRepositories(env))
          ),
    startPlanning: async (planId) => {
      try {
        await env.DISPATCH_WORKFLOW.create({ id: planId, params: { planId } })
      } catch (error) {
        await env.DISPATCH_WORKFLOW.get(planId).catch(() => {
          throw error
        })
      }
    },
    wakePlan: async (planId) => {
      const instance = await env.DISPATCH_WORKFLOW.get(planId)
      if ((await instance.status()).status === "errored")
        await instance.restart()
      try {
        await instance.sendEvent({ type: "dispatcher.launch", payload: {} })
      } catch {
        // A periodic gate read observes the already persisted launch command.
      }
    },
    retryPlan: async (planId) => {
      const instance = await env.DISPATCH_WORKFLOW.get(planId)
      if ((await instance.status()).status !== "errored")
        throw new DispatchError(
          409,
          "Only an errored Dispatcher run can be retried"
        )
      await instance.restart()
    },
  }
}

function repositories(env: Env): RepositoryHost {
  if (env.REPOSITORY_MODE === "fake")
    return new FakeRepositoryHost(
      env.FAKE_INTEGRATION_CONFLICT_PATHS.split(",")
        .map((path) => path.trim())
        .filter(Boolean)
    )
  if (env.REPOSITORY_MODE !== "artifacts")
    throw new Error("Configure REPOSITORY_MODE as artifacts or fake")
  return artifactsRepositories(env)
}

function stationRunner(env: Env, model: string): StationRunner {
  if (env.STATION_AGENT_MODEL !== FAKE) {
    if (env.REPOSITORY_MODE !== "artifacts")
      throw new Error("Real Station Agents require Artifacts repositories")
    return new SandboxStationRunner(
      env,
      model,
      artifactsRepositories(env),
      new NetworkStore(env.DB)
    )
  }
  const delayMs = Number(env.FAKE_AGENT_DELAY_MS)
  return new FakeStationRunner({
    delay: delayMs > 0 ? () => scheduler.wait(delayMs) : undefined,
  })
}

function conductor(env: Env, model: string): Conductor {
  if (env.CONDUCTOR_MODEL !== FAKE)
    return new ModelConductor(model, gatewayProvider(env, model))
  return new FakeConductor({ returns: Number(env.FAKE_CONDUCTOR_RETURNS) })
}

/** Gateway configuration is checked per call, so a misconfigured role fails its own step. */
function gatewayProvider(env: Env, model: string): ModelProvider {
  return {
    generateStructured: (request) =>
      new GatewayModelProvider(
        gatewayConfig(env, model),
        gatewayTransport
      ).generateStructured(request),
  }
}

async function startStationRun(
  env: Env,
  params: StationRunParams
): Promise<void> {
  try {
    await env.STATION_WORKFLOW.create({ id: params.runId, params })
  } catch (error) {
    // The run already exists if it can be fetched; otherwise creation failed.
    await env.STATION_WORKFLOW.get(params.runId).catch(() => {
      throw error
    })
  }
}

async function wakeTrain(env: Env, trainId: string): Promise<void> {
  const instance = await env.TRAIN_WORKFLOW.get(trainId)
  await instance.sendEvent({ type: TRAIN_EVENTS.wake, payload: {} })
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
}

export function junctionDispatchPorts(env: Env): JunctionDispatchPorts {
  return {
    ...dispatcherPorts(env),
    startJunction: async (id) => {
      try {
        await env.JUNCTION_WORKFLOW.create({ id, params: { junctionId: id } })
      } catch (error) {
        await env.JUNCTION_WORKFLOW.get(id).catch(() => {
          throw error
        })
      }
    },
    wakeJunction: async (id) => {
      const workflow = await env.JUNCTION_WORKFLOW.get(id)
      await workflow.sendEvent({ type: "junction-wake", payload: {} })
    },
  }
}
export function junctionExecutionPorts(env: Env, model: string) {
  return {
    ...junctionDispatchPorts(env),
    ...integrationPorts(env),
    conductor: conductor(env, model),
    startIntegration: async (id: string) => {
      try {
        await env.INTEGRATION_WORKFLOW.create({
          id,
          params: { integrationId: id },
        })
      } catch (error) {
        const workflow = await env.INTEGRATION_WORKFLOW.get(id).catch(() => {
          throw error
        })
        const attempt = await new NetworkStore(env.DB).integration(id)
        if (
          (await workflow.status()).status === "errored" &&
          attempt &&
          !attempt.result &&
          ["cleared", "prepared"].includes(attempt.status)
        )
          await workflow.restart()
      }
    },
  }
}
