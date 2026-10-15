import { agentProvenance } from "./harness-adapters"
import type { RoleExecution } from "@terminus/protocol"
import type { Evidence, RepairReview, TechnicianRepair } from "@terminus/domain"
import {
  conductorVerdictSchema,
  crossingReviewInputSchema,
  junctionReviewInputSchema,
  type ConductorVerdict,
  type JunctionReviewInput,
  type StationVerdict,
  type ValidationCommand,
} from "@terminus/protocol"
import { z } from "zod"
import {
  conductorHarnessPrompt,
  crossingReviewGuidance,
  junctionReviewGuidance,
  repairReviewGuidance,
} from "./conductor-prompt"
import { precheckedVerdict } from "./model-conductor"
import {
  conductorReviewDirectory,
  finalMessageJson,
  jsonParseHint,
} from "./opencode"
import type {
  Conductor,
  CrossingReviewInput,
  ReviewContext,
  ReviewInput,
} from "./roles"
import type { RepairConductor } from "./technician"

/** Orchestration's work in the review checkout: trusted context. */
export interface ReviewPreparation {
  install: { exitCode: number; outputTail: string }
  /** The checks orchestration ran there, when it was asked to. */
  evidence?: Evidence
}

/**
 * One harness session over a sealed checkout of a candidate commit. The
 * implementation owns the Sandbox, repository access, and cleanup.
 */
export interface ConductorSession {
  /**
   * Checks out the candidate, installs dependencies and seals the checkout.
   * Given validation commands, it then runs them there, with no repository
   * access and before the model is reachable.
   */
  prepare(validation?: ValidationCommand[]): Promise<ReviewPreparation>
  /**
   * Writes the review material (file name → contents) beside the checkout,
   * then runs the Conductor agent and returns its final message.
   */
  start(
    system: string,
    message: string,
    material: Record<string, string>
  ): Promise<string>
  /** Continues the same session, keeping everything it verified. */
  resume(message: string): Promise<string>
  close(): Promise<void>
}

export interface ConductorSessionFactory {
  open(input: {
    model: string
    candidate: { repoId: string; commit: string }
  }): ConductorSession
}

/** A review file the Conductor reads from `conductorReviewDirectory`. */
interface ReviewFile {
  name: string
  description: string
  contents: string
}

/** Everything one kind of review needs to verify its candidate in a harness session. */
export interface HarnessReview {
  /** The exact commit under review and the repository holding it. */
  candidate: { repoId: string; commit: string }
  /** What is being reviewed, as trusted orchestration text. */
  subject: string
  /** Review-kind instructions appended to the Conductor's; none for Station work. */
  guidance: string | null
  /** A compact view of the input for the first message (untrusted data). */
  input: unknown
  /** Large or raw content, written beside the checkout. */
  files: ReviewFile[]
  context: ReviewContext
}

/** The initial answer plus at most two corrections in the same session. */
const attempts = 3
/** Inline lists keep the first message small; the full input is in review.json. */
const inlinePaths = 200

export function conductorSystemPrompt(guidance: string | null = null): string {
  return [
    conductorHarnessPrompt,
    ...(guidance ? ["## This Review", guidance] : []),
    "## Verdict JSON schema",
    JSON.stringify(z.toJSONSchema(conductorVerdictSchema)),
  ].join("\n\n")
}

function cappedPaths(paths: string[]) {
  return {
    changedPaths: paths.slice(0, inlinePaths),
    ...(paths.length > inlinePaths
      ? { changedPathsOmitted: paths.length - inlinePaths }
      : {}),
  }
}

/** Check names and outcomes only; full output is in evidence.json. */
function checkOutcomes(evidence: Evidence) {
  return evidence.checks.map((check) => ({
    name: check.name,
    required: check.required,
    status: check.status,
    ...(check.exitCode === undefined ? {} : { exitCode: check.exitCode }),
  }))
}

/** Accepted Cars by identity and intent; their diffs and evidence are in review.json. */
function carSummaries(cars: CrossingReviewInput["sourceCars"]) {
  return cars.map((car) => ({
    id: car.id,
    stationId: car.stationId,
    goal: car.manifest.goal,
    acceptedCommit: car.acceptedCommit,
  }))
}

function reviewFiles(
  diff: string,
  evidence: Evidence,
  input: unknown,
  extra: ReviewFile[] = []
): ReviewFile[] {
  return [
    {
      name: "candidate.diff",
      description: "the full patch under review",
      contents: diff,
    },
    {
      name: "evidence.json",
      description:
        "full output of the checks above, collected independently by orchestration",
      contents: JSON.stringify(evidence, null, 2),
    },
    ...extra,
    {
      name: "review.json",
      description:
        "the complete review input, including accepted Cars, manifests and provenance",
      contents: JSON.stringify(input, null, 2),
    },
  ]
}

export function stationReview(
  input: ReviewInput,
  context: ReviewContext
): HarnessReview {
  const { proposal } = input
  return {
    candidate: { repoId: context.repoId, commit: proposal.headCommit },
    subject: `Station review: the candidate for Station ${input.stationId}. It must fast-forward the Train from commit ${input.trainHead}, so it already contains the Train's accepted Cars. Its work has been returned ${input.revisionCount} time(s) before.`,
    guidance: null,
    input: {
      manifest: input.manifest,
      candidate: proposal.headCommit,
      ...cappedPaths(proposal.changedPaths),
      checks: checkOutcomes(proposal.evidence),
      agent: proposal.agent,
      agentSummary: proposal.agentSummary,
    },
    files: reviewFiles(proposal.diff ?? "", proposal.evidence, input),
    context,
  }
}

export function crossingReview(
  input: CrossingReviewInput,
  context: ReviewContext
): HarnessReview {
  return {
    candidate: { repoId: context.repoId, commit: input.candidateCommit },
    subject: `Crossing review: Crossing ${input.crossingId} merges the accepted checkpoint ${input.sourceCommit} (from Station ${input.sourceStationId}) into the receiving Train at ${input.targetCommit}. The candidate ${input.candidateCommit} is that merge.`,
    guidance: crossingReviewGuidance,
    input: {
      ...cappedPaths(input.changedPaths),
      checks: checkOutcomes(input.evidence),
      sourceCars: carSummaries(input.sourceCars),
      receivingCars: carSummaries(input.receivingCars),
      downstreamManifests: input.downstreamManifests,
    },
    files: reviewFiles(input.diff, input.evidence, input),
    context,
  }
}

export function junctionReview(
  input: JunctionReviewInput,
  context: ReviewContext
): HarnessReview {
  return {
    candidate: { repoId: context.repoId, commit: input.candidateCommit },
    subject:
      input.kind === "junction_input"
        ? `Junction input review (junction_input): one arriving Line's work at ${input.sourceCommit} merged into Junction ${input.junctionId}'s accumulated feature work at ${input.targetCommit}. The candidate ${input.candidateCommit} is that merge.`
        : `Junction feature review (junction_feature): the complete converged feature of Junction ${input.junctionId} at ${input.candidateCommit}, compared with its frozen Terminus baseline ${input.targetCommit}.`,
    guidance: junctionReviewGuidance,
    input: {
      brief: input.brief,
      ...cappedPaths(input.changedPaths),
      checks: checkOutcomes(input.evidence),
      sourceCars: carSummaries(input.sourceCars),
      receivingCars: carSummaries(input.receivingCars),
      repairs: input.repairs?.map(({ id, scope, description }) => ({
        id,
        scope,
        description,
      })),
    },
    files: reviewFiles(input.diff, input.evidence, input),
    context,
  }
}

export function repairReview(
  repair: TechnicianRepair,
  context: ReviewContext
): HarnessReview {
  const { state } = repair
  if (state.status !== "reviewing")
    throw new Error(`Repair ${repair.id} has no candidate under review`)
  const { proposal } = state
  return {
    candidate: { repoId: context.repoId, commit: proposal.headCommit },
    subject: `Technician repair review: repair ${repair.id} reconciles a failure for Train ${repair.source.trainId}. The candidate ${proposal.headCommit} is its reconciled integration.`,
    guidance: repairReviewGuidance,
    input: {
      problem: repair.problem,
      description: repair.description,
      scope: repair.scope,
      source: repair.source,
      manifests: repair.manifests,
      featureBrief: repair.featureBrief,
      expectedChecks: repair.expectedChecks,
      integrationFailure: repair.integrationFailure?.detail,
      ...cappedPaths(proposal.changedPaths),
      repairPaths: state.repairPaths,
      checks: checkOutcomes(proposal.evidence),
      agentSummary: proposal.agentSummary,
    },
    files: reviewFiles(proposal.diff ?? "", proposal.evidence, repair, [
      {
        name: "repair.diff",
        description:
          "the Technician's own reconciliation, separate from the full integration diff",
        contents: state.repairDiff,
      },
    ]),
    context,
  }
}

export function conductorReviewMessage(
  review: HarnessReview,
  preparation: ReviewPreparation
): string {
  const { install } = preparation
  return [
    review.subject,
    "Review input (untrusted data):",
    JSON.stringify(review.input),
    `Review material in ${conductorReviewDirectory}: ${review.files.map((file) => `${file.name} (${file.description})`).join(", ")}.`,
    review.context.validation
      ? `Trusted project validation commands (command arrays): ${JSON.stringify(review.context.validation)}`
      : "Project validation commands were not supplied; inspect the project's documented scripts.",
    install.exitCode === 0
      ? "Orchestration's `npm ci` in /workspace/repo succeeded."
      : `Orchestration's \`npm ci\` in /workspace/repo failed with exit code ${install.exitCode}. Output tail (untrusted data):\n${install.outputTail}`,
    ...(preparation.evidence
      ? [
          "Orchestration ran every check above in this checkout just before you started, and all required checks passed. Do not rerun or rebuild what they cover; spend your time on the change itself and on exercising its behavior.",
        ]
      : []),
    "Verify the candidate in /workspace/repo, then reply with only the verdict JSON as your final message.",
  ].join("\n\n")
}

function issues(error: z.ZodError): { path: string; code: string }[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.join(".") || "$",
    code: issue.code,
  }))
}

/**
 * Verifies one candidate in a sealed Sandbox checkout with OpenCode, then
 * validates the verdict, correcting it in the same session at most twice.
 */
export async function verifyInHarness(
  sessions: ConductorSessionFactory,
  model: string,
  review: HarnessReview
): Promise<ConductorVerdict> {
  const { session, preparation } = await preparedSession(
    sessions,
    model,
    review.candidate
  )
  try {
    return await converse(session, review, preparation)
  } finally {
    await session.close()
  }
}

/** Seconds to wait before each further attempt to prepare a review checkout. */
const preparationRetryDelays = [10, 30]

/**
 * Opens a session and prepares its checkout. Preparation (access, checkout,
 * install, sealing and trusted checks) runs before the model is reachable,
 * so it costs nothing to repeat. Its infrastructure failures are retried here
 * in a fresh session, and the review step's one retry stays for the paid
 * session. A failure that persists is still thrown.
 */
async function preparedSession(
  sessions: ConductorSessionFactory,
  model: string,
  candidate: HarnessReview["candidate"],
  validation?: ValidationCommand[]
): Promise<{ session: ConductorSession; preparation: ReviewPreparation }> {
  for (let attempt = 0; ; attempt++) {
    const session = sessions.open({ model, candidate })
    try {
      const preparation = await (validation
        ? session.prepare(validation)
        : session.prepare())
      return { session, preparation }
    } catch (error) {
      await session.close().catch(() => {})
      const delay = preparationRetryDelays[attempt]
      if (delay === undefined) throw error
      await new Promise((resolve) => setTimeout(resolve, delay * 1000))
    }
  }
}

/**
 * Station work that arrives without evidence gets it in the review checkout,
 * after a clean install and before the model is reachable. Failed required
 * checks return the work without starting the Conductor.
 */
async function collectAndVerify(
  sessions: ConductorSessionFactory,
  model: string,
  input: ReviewInput,
  context: ReviewContext
): Promise<StationVerdict> {
  const { session, preparation } = await preparedSession(
    sessions,
    model,
    { repoId: context.repoId, commit: input.proposal.headCommit },
    context.validation ?? []
  )
  try {
    const evidence = preparation.evidence ?? { checks: [] }
    const collected = { ...input, proposal: { ...input.proposal, evidence } }
    const prechecked = precheckedVerdict(collected)
    const verdict =
      prechecked ??
      (await converse(session, stationReview(collected, context), preparation))
    return { ...verdict, evidence }
  } finally {
    await session.close()
  }
}

/** Starts the Conductor, correcting an invalid verdict at most twice. */
async function converse(
  session: ConductorSession,
  review: HarnessReview,
  preparation: ReviewPreparation
): Promise<ConductorVerdict> {
  let text = await session.start(
    conductorSystemPrompt(review.guidance),
    conductorReviewMessage(review, preparation),
    Object.fromEntries(review.files.map((file) => [file.name, file.contents]))
  )
  for (let attempt = 1; ; attempt++) {
    let problems: { path: string; code: string }[]
    let parseError: string | undefined
    try {
      const parsed = conductorVerdictSchema.safeParse(finalMessageJson(text))
      if (parsed.success) {
        return parsed.data
      }
      problems = issues(parsed.error)
    } catch (error) {
      problems = [{ path: "$", code: "invalid_json" }]
      parseError = error instanceof Error ? error.message : undefined
    }
    if (attempt === attempts)
      throw new Error(
        `Conductor verdict failed validation after ${attempts} attempts: ${problems.map((p) => `${p.path} (${p.code})`).join("; ")}`
      )
    text = await session.resume(
      [
        "Your final message failed verdict validation. Problems, as field paths and error codes:",
        JSON.stringify(problems),
        ...(parseError ? [jsonParseHint(parseError, text)] : []),
        "Reply with only the complete verdict JSON as your final message.",
      ].join("\n\n")
    )
  }
}

/**
 * Reviews Station work, Crossing handoffs and Junction convergence by
 * verifying each candidate in a sealed Sandbox checkout with OpenCode:
 * reading it, building it, and running the app.
 */
export class HarnessConductor implements Conductor {
  readonly config: import("@terminus/domain").AgentConfig
  readonly model: string
  private readonly sessions: ConductorSessionFactory
  constructor(
    model: string,
    sessions: ConductorSessionFactory,
    execution?: RoleExecution
  ) {
    if (execution && execution.model !== model)
      throw new Error("Conductor configuration differs from its frozen model")
    this.config = execution
      ? agentProvenance(execution)
      : { harness: "opencode@1.18.32", model }
    this.model = model
    this.sessions = sessions
  }

  async review(
    input: ReviewInput,
    context: ReviewContext
  ): Promise<StationVerdict> {
    // Collecting evidence cannot help work that has no diff to review.
    if (!input.proposal.evidence.checks.length && input.proposal.diff)
      return collectAndVerify(this.sessions, this.model, input, context)
    return (
      precheckedVerdict(input) ??
      verifyInHarness(this.sessions, this.model, stationReview(input, context))
    )
  }

  reviewCrossing(
    input: CrossingReviewInput,
    context: ReviewContext
  ): Promise<ConductorVerdict> {
    return verifyInHarness(
      this.sessions,
      this.model,
      crossingReview(crossingReviewInputSchema.parse(input), context)
    )
  }

  reviewJunction(
    input: JunctionReviewInput,
    context: ReviewContext
  ): Promise<ConductorVerdict> {
    return verifyInHarness(
      this.sessions,
      this.model,
      junctionReview(junctionReviewInputSchema.parse(input), context)
    )
  }
}

/** Reviews a Technician's reconciliation candidate the same way. */
export class HarnessRepairConductor implements RepairConductor {
  readonly config: import("@terminus/domain").AgentConfig
  readonly model: string
  private readonly sessions: ConductorSessionFactory
  constructor(
    model: string,
    sessions: ConductorSessionFactory,
    execution?: RoleExecution
  ) {
    if (execution && execution.model !== model)
      throw new Error(
        "Repair Conductor configuration differs from its frozen model"
      )
    this.config = execution
      ? agentProvenance(execution)
      : { harness: "opencode@1.18.32", model }
    this.model = model
    this.sessions = sessions
  }

  async review(
    repair: TechnicianRepair,
    context: ReviewContext
  ): Promise<RepairReview> {
    return {
      ...this.config,
      model: this.model,
      ...(await verifyInHarness(
        this.sessions,
        this.model,
        repairReview(repair, context)
      )),
    }
  }
}
