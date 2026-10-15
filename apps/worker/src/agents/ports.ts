import {
  createWorkflow,
  NetworkUnavailableError,
} from "../integrations/workflow-start"
import {
  FakeTechnicianRunner,
  FakeRepairConductor,
  ModelRepairConductor,
  FakeConductor,
  FakeEngineer,
  FakeStationRunner,
  GatewayDecisionModel,
  GatewayModelProvider,
  ModelEngineer,
  ModelConductor,
  HarnessConductor,
  HarnessRepairConductor,
  HarnessDispatcher,
  FakeDispatchPlanner,
  FakeConflictInvestigator,
  FakeConflictTriage,
  HarnessConflictInvestigator,
  ModelConflictTriage,
  type Conductor,
  type EngineerAdvisor,
  type ModelProvider,
  type RepairConductor,
  type StationRunner,
  executionConfig,
} from "@terminus/agent-runtime"
import {
  ArtifactsRepositoryHost,
  FakeRepositoryHost,
  type RepositoryHost,
} from "@terminus/artifacts"
import {
  scriptedStressAgent,
  harnessRoles,
  errorKind,
  perf,
  perfSpan,
  type RoleExecutions,
  type RoleExecution,
  type ReasoningLevel,
  type HarnessRole,
  type ModelRole,
} from "@terminus/protocol"
import { NetworkStore } from "../integrations/network-store"
import { SandboxWorkspaces } from "../integrations/sandbox-workspaces"
import { artifactsRepositories } from "../integrations/artifacts-repositories"
import { SandboxTechnicianRunner } from "../integrations/technician-runner"
import { SandboxDispatchSessions } from "../integrations/dispatch-session"
import { SandboxConflictSessions } from "../integrations/conflict-session"
import type { ConflictWatchPorts } from "../workflows/conflict-watch-operations"
import { DispatchActivityStore } from "../integrations/dispatch-activity"
import { SandboxConductorSessions } from "../integrations/conductor-session"
import type { TechnicianPorts } from "./technician"
import { SandboxStationRunner } from "../integrations/station-runner"
import {
  gatewayConfig,
  gatewayTransport,
  stationMaxRetries,
} from "../integrations/execution-config"
import type { JunctionDispatchPorts } from "./junctions"
import { DISPATCH_EVENTS, TRAIN_EVENTS } from "../workflows/events"
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
import { stressProfile } from "../integrations/stress-profile"
import { DispatchError, type DispatcherPorts } from "./dispatcher"
import type { DispatchPlanningPorts } from "./dispatch-planning"

/** A role configured as `fake` runs without a model. */
const FAKE = "fake"

/**
 * The model each role runs with for one piece of work. Resolved from the
 * network's settings when the work starts, or from what the work recorded.
 */
export type ConfiguredModels = Record<ModelRole, string> & {
  executions?: RoleExecutions
}
function configuredModels(executions: RoleExecutions): ConfiguredModels {
  return {
    executions,
    engineer: executions.engineer,
    ...Object.fromEntries(
      harnessRoles.map((role) => [role, executions[role].model])
    ),
  } as ConfiguredModels
}
function roleExecution(
  models: ConfiguredModels,
  role: HarnessRole
): RoleExecution {
  return models.executions?.[role] ?? executionConfig(models[role])
}

/** The models a network's settings choose right now. */
export async function networkModels(
  env: Env,
  networkId: string
): Promise<ConfiguredModels> {
  return configuredModels(
    await new NetworkStore(env.DB).networkExecutions(networkId)
  )
}

/** A Train and its Station runs use the models of the Train's network. */
export async function trainModels(
  env: Env,
  trainId: string
): Promise<ConfiguredModels> {
  const train = await new NetworkStore(env.DB).train(trainId)
  if (!train) throw new Error(`Unknown Train ${trainId}`)
  const config = await new NetworkStore(env.DB).executionConfig(
    "train",
    trainId
  )
  return config ? configuredModels(config) : legacyModels(env, train.networkId)
}

/** A plan keeps the Dispatcher model it was proposed with. */
export async function planModels(
  env: Env,
  planId: string
): Promise<ConfiguredModels> {
  const plan = await new NetworkStore(env.DB).dispatchPlan(planId)
  if (!plan) throw new Error(`Unknown plan ${planId}`)
  const config = await new NetworkStore(env.DB).executionConfig(
    "dispatch_plan",
    planId
  )
  if (config) return configuredModels(config)
  return {
    ...(await legacyModels(env, plan.networkId)),
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
  const config = await new NetworkStore(env.DB).executionConfig(
    "technician_repair",
    repairId
  )
  if (config) return configuredModels(config)
  return {
    ...(await legacyModels(env, repair.networkId)),
    technician: repair.value.agent.model,
  }
}

async function legacyModels(
  env: Env,
  networkId: string
): Promise<ConfiguredModels> {
  const models = await new NetworkStore(env.DB).roleModels(networkId)
  // Deployment drains old work before allowing external provider selections.
  for (const role of harnessRoles)
    if (!models[role].startsWith("@cf/"))
      throw new Error(
        "Legacy work has no frozen execution configuration; drain it before changing providers"
      )
  return models
}

export function trainPorts(env: Env, models: ConfiguredModels): TrainPorts {
  return {
    store: new NetworkStore(env.DB),
    repositories: repositories(env),
    conductor: conductor(
      env,
      models.conductor,
      models.executions?.conductor,
      stressProfile(models.executions)
    ),
    engineer: engineer(env, models.engineer, stressProfile(models.executions)),
    stationMaxRetries: stationMaxRetries(env),
    startStationRun: (params) => startStationRun(env, params),
    startIntegration: async (integrationId) => {
      try {
        await createWorkflow(
          env,
          env.INTEGRATION_WORKFLOW,
          "integration_attempts",
          integrationId,
          {
            id: integrationId,
            params: { integrationId },
          }
        )
      } catch (error) {
        if (error instanceof NetworkUnavailableError) throw error
        await env.INTEGRATION_WORKFLOW.get(integrationId).catch(() => {
          throw error
        })
      }
    },
    wakeJunction: (id) => junctionDispatchPorts(env).wakeJunction(id),
    wakeTrain: (trainId) => wakeTrain(env, trainId),
    startConflictWatch: async (watchId, trainId) => {
      try {
        await createWorkflow(
          env,
          env.CONFLICT_WATCH_WORKFLOW,
          "trains",
          trainId,
          { id: watchId, params: { watchId, trainId } }
        )
      } catch (error) {
        if (error instanceof NetworkUnavailableError) throw error
        await env.CONFLICT_WATCH_WORKFLOW.get(watchId).catch(() => {
          throw error
        })
      }
    },
    newId,
    now: () => new Date().toISOString(),
  }
}

/**
 * The Dispatcher's conflict watch: the Engineer's Clef model triages, and
 * the Dispatcher's harness investigates in a read-only Sandbox.
 */
export function conflictWatchPorts(
  env: Env,
  models: ConfiguredModels
): ConflictWatchPorts {
  return {
    store: new NetworkStore(env.DB),
    triage:
      stressProfile(models.executions) || env.ENGINEER_MODEL === FAKE
        ? new FakeConflictTriage()
        : new ModelConflictTriage(models.engineer, {
            decide: (request) =>
              new GatewayDecisionModel(
                directGatewayConfig(env, models.engineer),
                gatewayTransport
              ).decide(request),
          }),
    investigator:
      stressProfile(models.executions) ||
      env.DISPATCHER_MODEL === FAKE ||
      env.REPOSITORY_MODE !== "artifacts"
        ? new FakeConflictInvestigator()
        : new HarnessConflictInvestigator(
            models.dispatcher,
            new SandboxConflictSessions(
              env,
              artifactsRepositories(env),
              undefined,
              roleExecution(models, "dispatcher")
            ),
            roleExecution(models, "dispatcher")
          ),
    now: () => new Date().toISOString(),
  }
}

export function integrationPorts(env: Env): IntegrationPorts {
  const host = repositories(env)
  return {
    conductorForTrain: async (id, model, junctionId) => {
      if (junctionId) {
        const execution = (
          await new NetworkStore(env.DB).executionConfig("junction", junctionId)
        )?.conductor
        if (execution) return conductor(env, execution.model, execution)
        if (model) return conductor(env, model)
      }
      const models = await trainModels(env, id)
      const execution = models.executions?.conductor
      return conductor(
        env,
        execution?.model ?? model ?? models.conductor,
        execution,
        stressProfile(models.executions)
      )
    },
    store: new NetworkStore(env.DB),
    repositories: host,
    validator:
      host instanceof ArtifactsRepositoryHost
        ? new SandboxIntegrationValidator(host, new SandboxWorkspaces(env))
        : new FakeIntegrationValidator(),
    // Fake Station runs carry their own evidence, and with a fake Conductor
    // real Station runs collect it in the Station Agent's Sandbox.
    independentCarEvidence:
      env.STATION_AGENT_MODEL !== FAKE && env.CONDUCTOR_MODEL !== FAKE,
  }
}

export function technicianPorts(
  env: Env,
  models: ConfiguredModels
): TechnicianPorts {
  const host = repositories(env)
  return {
    ...dispatcherPorts(env, models),
    repositories: host,
    runner:
      env.TECHNICIAN_MODEL === FAKE
        ? new FakeTechnicianRunner()
        : new SandboxTechnicianRunner(
            env,
            models.technician,
            artifactsRepositories(env),
            undefined,
            roleExecution(models, "technician")
          ),
    reviewer: repairConductor(
      env,
      models.conductor,
      models.executions?.conductor
    ),
    validator:
      host instanceof ArtifactsRepositoryHost
        ? new SandboxIntegrationValidator(host, new SandboxWorkspaces(env))
        : new FakeIntegrationValidator(),
    startRepair: async (repairId) => {
      try {
        await createWorkflow(
          env,
          env.TECHNICIAN_WORKFLOW,
          "technician_repairs",
          repairId,
          {
            id: repairId,
            params: { repairId },
          }
        )
      } catch (error) {
        if (error instanceof NetworkUnavailableError) throw error
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
    runner: stationRunner(
      env,
      models.stationAgent,
      models.executions?.stationAgent,
      stressProfile(models.executions)
    ),
  }
}

export function dispatcherPorts(
  env: Env,
  models?: ConfiguredModels
): DispatcherPorts {
  return {
    store: new NetworkStore(env.DB, models?.executions),
    repositories: repositories(env),
    startTrain: async (trainId) => {
      try {
        await createWorkflow(env, env.TRAIN_WORKFLOW, "trains", trainId, {
          id: trainId,
          params: { trainId },
        })
      } catch (error) {
        if (error instanceof NetworkUnavailableError) throw error
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
    ...dispatcherPorts(env, models),
    activity: new DispatchActivityStore(env.DB),
    startJunction: (id) => junctionDispatchPorts(env).startJunction(id),
    planner:
      env.DISPATCHER_MODEL === FAKE
        ? new FakeDispatchPlanner()
        : new HarnessDispatcher(
            models.dispatcher,
            new SandboxDispatchSessions(
              env,
              artifactsRepositories(env),
              undefined,
              roleExecution(models, "dispatcher")
            ),
            roleExecution(models, "dispatcher")
          ),
    startPlanning: async (planId) => {
      try {
        await createWorkflow(
          env,
          env.DISPATCH_WORKFLOW,
          "dispatch_plans",
          planId,
          { id: planId, params: { planId } }
        )
      } catch (error) {
        if (error instanceof NetworkUnavailableError) throw error
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
        await instance.sendEvent({ type: DISPATCH_EVENTS.launch, payload: {} })
        perf("dispatch.launch_event_sent", { planId })
      } catch (error) {
        // A periodic gate read observes the already persisted launch command.
        perf("dispatch.launch_event_failed", {
          planId,
          error: errorKind(error),
        })
      }
    },
    stopPlan: async (planId) => {
      const results = await Promise.allSettled([
        ...(env.DISPATCHER_MODEL === FAKE
          ? []
          : [env.SANDBOX.getByName(`dispatch-${planId}`).cancel()]),
        (async () => {
          try {
            const instance = await env.DISPATCH_WORKFLOW.get(planId)
            const { status } = await instance.status()
            if (!["terminated", "complete", "errored"].includes(status))
              await instance.terminate()
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !/(?:instance\.not_found|instance (?:does not exist|not found))/i.test(
                error.message
              )
            )
              throw error
          }
        })(),
      ])
      if (results.some((result) => result.status === "rejected"))
        throw new DispatchError(
          503,
          "Planning is cancelled, but cleanup is incomplete. Press Stop again to retry."
        )
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

function stationRunner(
  env: Env,
  model: string,
  execution?: RoleExecution,
  scripted = false
): StationRunner {
  if (scripted && env.REPOSITORY_MODE === "artifacts")
    return new SandboxStationRunner(
      env,
      model,
      artifactsRepositories(env),
      new NetworkStore(env.DB),
      undefined,
      execution,
      false,
      true
    )
  if (!scripted && env.STATION_AGENT_MODEL !== FAKE) {
    if (env.REPOSITORY_MODE !== "artifacts")
      throw new Error("Real Station Agents require Artifacts repositories")
    return new SandboxStationRunner(
      env,
      model,
      artifactsRepositories(env),
      new NetworkStore(env.DB),
      undefined,
      execution,
      // A fake Conductor collects no evidence, so the Station run must.
      env.CONDUCTOR_MODEL === FAKE
    )
  }
  const delayMs = Number(env.FAKE_AGENT_DELAY_MS)
  return new FakeStationRunner({
    delay: delayMs > 0 ? () => scheduler.wait(delayMs) : undefined,
  })
}

function conductor(
  env: Env,
  model: string,
  execution?: RoleExecution,
  scripted = false
): Conductor {
  const reviewer = configuredConductor(env, model, execution, scripted)
  if (scripted) return reviewer
  return {
    config: reviewer.config,
    model: reviewer.model,
    review: (input, context) => {
      if (
        input.proposal.agent.harness === scriptedStressAgent.harness ||
        input.manifest.goal.startsWith("Pipeline stress ten-trains-v1 ")
      )
        throw new Error(
          "Use the explicit stress-test command before reviewing this fixture"
        )
      return reviewer.review(input, context)
    },
    ...(reviewer.reviewCrossing
      ? { reviewCrossing: reviewer.reviewCrossing.bind(reviewer) }
      : {}),
    ...(reviewer.reviewJunction
      ? { reviewJunction: reviewer.reviewJunction.bind(reviewer) }
      : {}),
  }
}

function configuredConductor(
  env: Env,
  model: string,
  execution?: RoleExecution,
  scripted = false
): Conductor {
  if (scripted && env.REPOSITORY_MODE === "fake")
    return new FakeConductor({ returns: 0 })
  if (scripted) {
    const reviewer = new HarnessConductor(
      scriptedStressAgent.model,
      new SandboxConductorSessions(
        env,
        artifactsRepositories(env),
        undefined,
        undefined,
        true
      )
    )
    return {
      config: scriptedStressAgent,
      model: scriptedStressAgent.model,
      // Always recollect checks in the sealed checkout, even if a caller supplied evidence.
      review: (input, context) =>
        reviewer.review(
          {
            ...input,
            proposal: { ...input.proposal, evidence: { checks: [] } },
          },
          context
        ),
    }
  }
  if (env.CONDUCTOR_MODEL === FAKE)
    return new FakeConductor({ returns: Number(env.FAKE_CONDUCTOR_RETURNS) })
  // Verifying a candidate in a Sandbox needs its real repository; fake
  // repositories are reviewed from the supplied diff alone.
  if (env.REPOSITORY_MODE !== "artifacts")
    return new ModelConductor(
      model,
      gatewayProvider(env, model, execution?.reasoning)
    )
  return new HarnessConductor(
    model,
    conductorSessions(env, execution),
    execution
  )
}

function repairConductor(
  env: Env,
  model: string,
  execution?: RoleExecution
): RepairConductor {
  if (env.CONDUCTOR_MODEL === FAKE) return new FakeRepairConductor()
  if (env.REPOSITORY_MODE !== "artifacts")
    return new ModelRepairConductor(
      model,
      gatewayProvider(env, model, execution?.reasoning)
    )
  return new HarnessRepairConductor(
    model,
    conductorSessions(env, execution),
    execution
  )
}

function conductorSessions(
  env: Env,
  execution?: RoleExecution
): SandboxConductorSessions {
  return new SandboxConductorSessions(
    env,
    artifactsRepositories(env),
    undefined,
    execution
  )
}

/** The Engineer's decision model. A misconfigured Gateway fails each call, and
 * the Engineer escalates rather than guessing. */
function engineer(env: Env, model: string, scripted = false): EngineerAdvisor {
  if (scripted || env.ENGINEER_MODEL === FAKE) return new FakeEngineer()
  return new ModelEngineer(model, {
    decide: (request) =>
      new GatewayDecisionModel(
        directGatewayConfig(env, model),
        gatewayTransport
      ).decide(request),
  })
}

/** Gateway configuration is checked per call, so a misconfigured role fails its own step. */
function gatewayProvider(
  env: Env,
  model: string,
  reasoning?: ReasoningLevel
): ModelProvider {
  return {
    generateStructured: (request) =>
      new GatewayModelProvider(
        { ...directGatewayConfig(env, model), reasoning },
        gatewayTransport
      ).generateStructured(request),
  }
}

function directGatewayConfig(env: Env, model: string) {
  const config = gatewayConfig(env, model)
  if (config.provider !== "workers-ai")
    throw new Error(
      "External-provider reviews require real candidate repositories and a Sandbox harness"
    )
  return config
}

async function startStationRun(
  env: Env,
  params: StationRunParams
): Promise<void> {
  try {
    await createWorkflow(
      env,
      env.STATION_WORKFLOW,
      "stations",
      params.stationId,
      { id: params.runId, params }
    )
  } catch (error) {
    if (error instanceof NetworkUnavailableError) throw error
    // The run already exists if it can be fetched; otherwise creation failed.
    await env.STATION_WORKFLOW.get(params.runId).catch(() => {
      throw error
    })
  }
}

async function wakeTrain(env: Env, trainId: string): Promise<void> {
  await perfSpan("train.wake_sent", { trainId }, async () => {
    const instance = await env.TRAIN_WORKFLOW.get(trainId)
    await instance.sendEvent({ type: TRAIN_EVENTS.wake, payload: {} })
  })
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
}

export function junctionDispatchPorts(
  env: Env,
  models?: ConfiguredModels
): JunctionDispatchPorts {
  return {
    ...dispatcherPorts(env, models),
    startJunction: async (id) => {
      try {
        await createWorkflow(env, env.JUNCTION_WORKFLOW, "junctions", id, {
          id,
          params: { junctionId: id },
        })
      } catch (error) {
        if (error instanceof NetworkUnavailableError) throw error
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
export function junctionExecutionPorts(
  env: Env,
  model: string,
  execution?: RoleExecution
) {
  return {
    ...junctionDispatchPorts(env),
    ...integrationPorts(env),
    conductor: conductor(env, execution?.model ?? model, execution),
    startIntegration: async (id: string) => {
      try {
        await createWorkflow(
          env,
          env.INTEGRATION_WORKFLOW,
          "integration_attempts",
          id,
          {
            id,
            params: { integrationId: id },
          }
        )
      } catch (error) {
        if (error instanceof NetworkUnavailableError) throw error
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
