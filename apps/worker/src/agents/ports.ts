import {
  FakeConductor,
  FakeStationRunner,
  GatewayModelProvider,
  ModelConductor,
  ModelDispatcher,
  FakeDispatchPlanner,
  type Conductor,
  type StationRunner,
} from "@terminus/agent-runtime"
import {
  ArtifactsRepositoryHost,
  FakeRepositoryHost,
  type RepositoryHost,
} from "@terminus/artifacts"
import { NetworkStore } from "../integrations/network-store"
import { SandboxWorkspaces } from "../integrations/sandbox-workspaces"
import { SandboxStationRunner } from "../integrations/station-runner"
import {
  gatewayConfig,
  gatewayTransport,
} from "../integrations/execution-config"
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

export function trainPorts(env: Env): TrainPorts {
  return {
    store: new NetworkStore(env.DB),
    repositories: repositories(env),
    conductor: conductor(env),
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
    wakeTrain: (trainId) => wakeTrain(env, trainId),
    newId,
    now: () => new Date().toISOString(),
  }
}

export function integrationPorts(env: Env): IntegrationPorts {
  const host = repositories(env)
  return {
    store: new NetworkStore(env.DB),
    repositories: host,
    validator:
      host instanceof ArtifactsRepositoryHost
        ? new SandboxIntegrationValidator(host, new SandboxWorkspaces(env))
        : new FakeIntegrationValidator(),
  }
}

export function stationPorts(env: Env): StationPorts {
  return {
    store: new NetworkStore(env.DB),
    repositories: repositories(env),
    runner: stationRunner(env),
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

export function dispatchPlanningPorts(env: Env): DispatchPlanningPorts {
  return {
    ...dispatcherPorts(env),
    planner:
      env.DISPATCHER_MODEL === FAKE
        ? new FakeDispatchPlanner()
        : new ModelDispatcher(env.DISPATCHER_MODEL, {
            generateStructured: (request) =>
              new GatewayModelProvider(
                gatewayConfig(env, env.DISPATCHER_MODEL),
                gatewayTransport
              ).generateStructured(request),
          }),
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

function realRepositories(env: Env): ArtifactsRepositoryHost {
  if (!env.ARTIFACTS) throw new Error("Artifacts binding is missing")
  return new ArtifactsRepositoryHost(
    env.ARTIFACTS,
    new SandboxWorkspaces(env),
    () => scheduler.wait(1000)
  )
}

function repositories(env: Env): RepositoryHost {
  if (env.REPOSITORY_MODE === "fake") return new FakeRepositoryHost()
  if (env.REPOSITORY_MODE !== "artifacts")
    throw new Error("Configure REPOSITORY_MODE as artifacts or fake")
  return realRepositories(env)
}

function stationRunner(env: Env): StationRunner {
  if (env.STATION_AGENT_MODEL !== FAKE) {
    if (env.REPOSITORY_MODE !== "artifacts")
      throw new Error("Real Station Agents require Artifacts repositories")
    return new SandboxStationRunner(
      env,
      realRepositories(env),
      new NetworkStore(env.DB)
    )
  }
  const delayMs = Number(env.FAKE_AGENT_DELAY_MS)
  return new FakeStationRunner({
    delay: delayMs > 0 ? () => scheduler.wait(delayMs) : undefined,
  })
}

function conductor(env: Env): Conductor {
  if (env.CONDUCTOR_MODEL !== FAKE) {
    return new ModelConductor(env.CONDUCTOR_MODEL, {
      generateStructured: (request) =>
        new GatewayModelProvider(
          gatewayConfig(env, env.CONDUCTOR_MODEL),
          gatewayTransport
        ).generateStructured(request),
    })
  }
  return new FakeConductor({ returns: Number(env.FAKE_CONDUCTOR_RETURNS) })
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
