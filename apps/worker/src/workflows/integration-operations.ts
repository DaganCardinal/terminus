import {
  blockingIssues,
  holdReasons,
  conflictsForRepair,
  evidenceCovers,
  repairMatches,
  evaluateTerminusEntry,
  unmetRequiredChecks,
  type Evidence,
} from "@terminus/domain"
import type { RepositoryHost } from "@terminus/artifacts"
import {
  conductorVerdictSchema,
  evidenceSchema,
  type IntegrationAttempt,
  type IntegrationCandidate,
  type IntegrationResult,
} from "@terminus/protocol"
import type { NetworkStore } from "../integrations/network-store"
import type { IntegrationValidator } from "../integrations/integration-validator"

export interface IntegrationPorts {
  store: NetworkStore
  repositories: RepositoryHost
  validator: IntegrationValidator
  conductorForTrain?(
    trainId: string,
    model?: string,
    junctionId?: string
  ): Promise<import("@terminus/agent-runtime").Conductor>
}

async function load(
  ports: IntegrationPorts,
  id: string
): Promise<IntegrationAttempt> {
  const attempt = await ports.store.integration(id)
  if (!attempt) throw new Error("Unknown integration attempt")
  return attempt
}

/** Merge into a separate durable repo; collect evidence with no canonical write credentials. */
export async function prepareIntegration(
  ports: IntegrationPorts,
  id: string
): Promise<void> {
  await validateIntegration(ports, id, await mergeIntegration(ports, id))
}

/**
 * Builds the durable merge candidate, or returns null once there is nothing
 * left to validate. A separate Workflow step from validation, so a validation
 * retry reuses this result instead of merging again.
 */
export async function mergeIntegration(
  ports: IntegrationPorts,
  id: string
): Promise<IntegrationCandidate | null> {
  const attempt = await load(ports, id)
  if (attempt.status !== "cleared" || attempt.result) return null
  const { input } = attempt
  const train =
    input.purpose === "junction"
      ? await junctionSource(ports, input)
      : await ports.store.train(input.trainId)
  if (
    !train ||
    (input.purpose === "junction"
      ? false
      : input.purpose === "crossing"
        ? !crossingVisitMatches(train.value, input)
        : train.value.headCommit !== input.trainCommit ||
          train.value.state.status !== "returning" ||
          train.value.state.phase !== "integrating")
  )
    throw new Error("Train no longer matches Dispatcher clearance")
  if (input.purpose === "crossing") await assertCrossing(ports, input)
  let merged: import("@terminus/artifacts").IntegrationMerge
  if (input.purpose !== "crossing" && input.repairId) {
    const repair = (await ports.store.repair(input.repairId))?.value
    if (
      !repair ||
      repair.state.status !== "approved" ||
      repair.source.trainId !== input.trainId ||
      !repairMatches(repair, input) ||
      JSON.stringify(repair.source.acceptedCommits) !==
        JSON.stringify(input.acceptedCommits)
    )
      throw new Error("Approved repair no longer matches integration sources")
    const candidate = {
      repoId: repair.state.workspaceRepoId,
      headCommit: repair.state.proposal.headCommit,
    }
    // The Technician's inspection derived the reviewed diffs, parents and
    // ancestry from these exact commit IDs, so only the repositories can
    // have changed since.
    await ports.repositories.confirmRepair(repair, candidate)
    merged = { ok: true, candidate }
  } else merged = await ports.repositories.prepareIntegration(input)
  if (!merged.ok) {
    await ports.store.finishIntegration(id, {
      ok: false,
      issues: [
        {
          kind: "conflict",
          detail: `${input.purpose === "junction" ? "Junction" : input.purpose === "crossing" ? "Crossing" : "Terminus"} merge conflicts: ${merged.conflictPaths.join(", ")}`,
        },
      ],
      conflictPaths: merged.conflictPaths,
    })
    return null
  }
  return merged.candidate
}

/**
 * Collects independent evidence for the merged candidate and checkpoints it.
 * Failing evidence finishes the attempt, including after a crash between
 * the checkpoint and that result.
 */
export async function validateIntegration(
  ports: IntegrationPorts,
  id: string,
  candidate: IntegrationCandidate | null
): Promise<void> {
  const attempt = await load(ports, id)
  if (attempt.result) return
  const { input } = attempt
  let evidence: Evidence
  if (attempt.status === "prepared" && attempt.evidence)
    evidence = attempt.evidence
  else if (attempt.status === "cleared" && candidate) {
    evidence =
      (await reusableRepairEvidence(ports, attempt, candidate)) ??
      evidenceSchema.parse(
        await ports.validator.validate(candidate, input.validation)
      )
    await ports.store.prepareIntegration(id, candidate, evidence)
  } else return
  const failing = unmetRequiredChecks(
    evidence,
    input.validation.map((check) => check.name)
  )
  if (failing.length > 0) {
    await ports.store.finishIntegration(id, {
      ok: false,
      evidence,
      issues: [
        {
          kind: "required_checks_failed",
          detail: `Project-wide validation did not pass: ${failing.map((check) => check.name).join(", ")}`,
        },
      ],
    })
    return
  }
}

/**
 * The independent validator already ran on an approved repair's exact
 * candidate. Running the same commands on the same commit again proves
 * nothing new, so that evidence stands when it covers this attempt's checks.
 */
async function reusableRepairEvidence(
  ports: IntegrationPorts,
  attempt: IntegrationAttempt,
  candidate: IntegrationCandidate
): Promise<Evidence | null> {
  const { input } = attempt
  if (input.purpose === "crossing" || !input.repairId) return null
  const repair = (await ports.store.repair(input.repairId))?.value
  if (
    repair?.state.status !== "approved" ||
    repair.state.workspaceRepoId !== candidate.repoId ||
    repair.state.proposal.headCommit !== candidate.headCommit
  )
    return null
  const evidence = evidenceSchema.parse(repair.state.proposal.evidence)
  return evidenceCovers(evidence, input.validation) ? evidence : null
}

/** Never re-merge during promotion: push exactly the independently validated commit. */
export async function promoteIntegration(
  ports: IntegrationPorts,
  id: string
): Promise<IntegrationResult> {
  const attempt = await load(ports, id)
  if (attempt.result) return attempt.result
  if (attempt.status !== "prepared" || !attempt.candidate || !attempt.evidence)
    throw new Error("Integration has no validated durable candidate")
  const { input, candidate, evidence } = attempt
  const failing = unmetRequiredChecks(
    evidence,
    input.validation.map((check) => check.name)
  )
  if (failing.length > 0) {
    const result: IntegrationResult = {
      ok: false,
      evidence,
      issues: [
        {
          kind: "required_checks_failed",
          detail:
            "Integration checkpoint is missing passing project-wide evidence",
        },
      ],
    }
    await ports.store.finishIntegration(id, result)
    return result
  }
  // A successful push with a lost D1 acknowledgement must be completed before
  // checking new holds: that accepted canonical state cannot be undone.
  const head = await ports.repositories.head(input.terminusRepoId)
  if (
    head === candidate.headCommit &&
    ((input.purpose ?? "terminus") === "terminus" ||
      attempt.review?.verdict === "accept")
  )
    return complete(ports, attempt, evidence)
  let train =
    input.purpose === "junction"
      ? await junctionSource(ports, input)
      : await ports.store.train(input.trainId)
  if (
    !train ||
    (input.purpose === "junction"
      ? false
      : input.purpose === "crossing"
        ? !crossingVisitMatches(train.value, input)
        : train.value.headCommit !== input.trainCommit ||
          train.value.state.status !== "returning" ||
          train.value.state.phase !== "integrating")
  )
    throw new Error("Train changed before Terminus promotion")
  if (input.purpose === "crossing") {
    await assertCrossing(ports, input)
    await reviewCrossingCandidate(ports, attempt, train.value.lineId)
    const review = (await load(ports, id)).review
    if (review?.verdict !== "accept") {
      const result: IntegrationResult = {
        ok: false,
        evidence,
        issues: [
          {
            kind: "review_escalated",
            detail: review?.summary ?? "Crossing review unavailable",
          },
        ],
      }
      await ports.store.finishIntegration(id, result)
      return result
    }
  }
  if (input.purpose === "junction") {
    await reviewJunctionInput(ports, attempt)
    const reviewed = await load(ports, id)
    if (reviewed.review?.verdict !== "accept") {
      const result: IntegrationResult = {
        ok: false,
        evidence,
        issues: [
          {
            kind: "review_escalated",
            detail: reviewed.review?.summary ?? "Junction review unavailable",
          },
        ],
      }
      await ports.store.finishIntegration(id, result)
      return result
    }
    train = await junctionSource(ports, input)
  }
  if (input.purpose === "crossing") {
    // Model review may take time: recheck the stopped visit and its reservation
    // against current state before applying the reviewed candidate.
    train = await ports.store.train(input.trainId)
    const reserved = await load(ports, id)
    if (
      !train ||
      !crossingVisitMatches(train.value, input) ||
      reserved.status !== "prepared" ||
      reserved.candidate?.headCommit !== candidate.headCommit
    )
      throw new Error(
        "Receiving visit or promotion reservation changed during review"
      )
    await assertCrossing(ports, input)
  }
  const repair =
    input.purpose !== "crossing" && input.repairId
      ? ((await ports.store.repair(input.repairId))?.value ?? null)
      : null
  if (
    input.repairId &&
    (!repair ||
      repair.state.status !== "approved" ||
      !repairMatches(repair, input) ||
      repair.state.proposal.headCommit !== candidate.headCommit)
  )
    throw new Error("Repair approval changed before promotion")
  const gate = (
    input.purpose === "crossing" || input.purpose === "junction"
      ? evaluateCrossingPromotion
      : evaluateTerminusEntry
  )(train.value, {
    unloadPolicy: (await ports.store.unloadPolicy(train.value.id))?.value,
    holds: await ports.store.holds(input.networkId),
    conflicts: conflictsForRepair(
      await ports.store.conflicts(input.networkId),
      repair,
      input
    ),
    trainChecks: evidence.checks,
  })
  if (gate.kind !== "clear") {
    const result: IntegrationResult = {
      ok: false,
      issues:
        gate.kind === "block"
          ? gate.issues
          : [
              {
                kind: "needs_user",
                detail: "Promotion deferred until the entry hold clears",
              },
            ],
      ...(gate.kind === "hold" ? { holds: gate.reasons } : {}),
    }
    await ports.store.finishIntegration(id, result)
    return result
  }
  await ports.repositories.fastForward({
    targetRepoId: input.terminusRepoId,
    sourceRepoId: candidate.repoId,
    fromCommit: input.terminusCommit,
    toCommit: candidate.headCommit,
  })
  return complete(ports, attempt, evidence)
}

async function complete(
  ports: IntegrationPorts,
  attempt: IntegrationAttempt,
  evidence: Evidence
): Promise<IntegrationResult> {
  const result: IntegrationResult = {
    ok: true,
    mergeCommit: attempt.candidate!.headCommit,
    evidence,
  }
  await ports.store.finishIntegration(attempt.input.id, result)
  return result
}

/** On exhausted retries, distinguish an acknowledged failure from a lost push response. */
export async function failIntegration(
  ports: IntegrationPorts,
  id: string,
  detail: string
): Promise<IntegrationResult> {
  const attempt = await load(ports, id)
  if (attempt.result) return attempt.result
  if (attempt.status === "prepared") {
    const failing = unmetRequiredChecks(
      attempt.evidence!,
      attempt.input.validation.map((check) => check.name)
    )
    if (failing.length > 0) {
      const result: IntegrationResult = {
        ok: false,
        evidence: attempt.evidence!,
        issues: [
          {
            kind: "required_checks_failed",
            detail: "Project-wide validation did not pass before promotion",
          },
        ],
      }
      await ports.store.finishIntegration(id, result)
      return result
    }
    // If this lookup fails, retain the reservation. Releasing an uncertain
    // canonical write would allow another promotion to race its recovery.
    const head = await ports.repositories.head(attempt.input.terminusRepoId)
    if (
      head === attempt.candidate!.headCommit &&
      ((attempt.input.purpose ?? "terminus") === "terminus" ||
        attempt.review?.verdict === "accept")
    )
      return complete(ports, attempt, attempt.evidence!)
  }
  const result: IntegrationResult = {
    ok: false,
    issues: [{ kind: "integration_failed", detail }],
  }
  await ports.store.finishIntegration(id, result)
  return result
}

function crossingVisitMatches(
  train: import("@terminus/domain").Train,
  input: import("@terminus/protocol").IntegrationInput
): boolean {
  return (
    train.headCommit === input.terminusCommit &&
    (train.state.status === "docked" || train.state.status === "reviewing") &&
    train.state.crossingId === input.crossingId
  )
}
function evaluateCrossingPromotion(
  train: import("@terminus/domain").Train,
  context: import("@terminus/domain").GateContext
) {
  const issues = blockingIssues(train, context),
    reasons = holdReasons(train, context)
  return issues.length
    ? { kind: "block" as const, issues }
    : reasons.length
      ? { kind: "hold" as const, reasons }
      : { kind: "clear" as const }
}

async function assertCrossing(
  ports: IntegrationPorts,
  input: import("@terminus/protocol").IntegrationInput
) {
  const loaded = input.crossingId
    ? await ports.store.crossing(input.crossingId)
    : null
  const train = await ports.store.train(input.trainId)
  if (
    !loaded ||
    loaded.networkId !== input.networkId ||
    loaded.value.lineId !== train?.value.lineId ||
    loaded.value.state.status !== "integrating" ||
    loaded.value.state.integrationId !== input.id ||
    loaded.value.checkpoint?.commit !== input.trainCommit ||
    loaded.value.checkpoint.repoId !== input.trainRepoId ||
    train.value.repoId !== input.terminusRepoId
  )
    throw new Error("Crossing no longer matches its frozen handoff")
}

async function junctionSource(
  ports: IntegrationPorts,
  input: import("@terminus/protocol").IntegrationInput
) {
  const j = input.junctionId
    ? await ports.store.junction(input.junctionId)
    : null
  if (
    !j ||
    j.networkId !== input.networkId ||
    j.value.repoId !== input.terminusRepoId ||
    j.value.headCommit !== input.terminusCommit ||
    j.value.state.status !== "collecting"
  )
    throw new Error("Junction target changed before promotion")
  const repair = input.repairId
    ? await ports.store.repair(input.repairId)
    : null
  if (repair?.value.source.kind === "junction_feature") {
    if (
      repair.value.source.junctionId !== j.value.id ||
      repair.value.state.status !== "approved" ||
      input.trainRepoId !== j.value.repoId ||
      input.trainCommit !== j.value.headCommit
    )
      throw new Error("Feature repair sources changed")
    return {
      ...j,
      value: {
        id: j.value.outgoingTrainId,
        lineId: j.value.outgoingLineId,
        repoId: j.value.repoId,
        terminusBaseline: j.value.terminusBaseline,
        headCommit: j.value.headCommit,
        carIds: [],
        state: {
          status: "ready" as const,
          at: { kind: "junction" as const, junctionId: j.value.id },
        },
      },
    }
  }
  const train = await ports.store.train(input.trainId)
  if (
    !train ||
    !j.value.incomingTrainIds.includes(train.value.id) ||
    train.value.destination?.kind !== "junction" ||
    train.value.destination.junctionId !== j.value.id ||
    train.value.repoId !== input.trainRepoId ||
    train.value.headCommit !== input.trainCommit ||
    !(
      train.value.state.status === "returning" ||
      (train.value.state.status === "held" &&
        train.value.state.resume.status === "returning") ||
      (repair?.value.state.status === "approved" &&
        train.value.state.status === "blocked")
    )
  )
    throw new Error("Junction input changed before promotion")
  return train
}
/**
 * Records the Conductor's review of a prepared Crossing or Junction-input
 * candidate. A sandboxed review takes minutes, so the Integration Workflow
 * runs this as its own step before promotion; promotion calls the same
 * reviews again, which do nothing once a review is recorded. Terminus
 * integration has no Conductor review here.
 */
export async function reviewIntegration(
  ports: IntegrationPorts,
  id: string
): Promise<void> {
  const attempt = await load(ports, id)
  if (attempt.result || attempt.review || attempt.status !== "prepared") return
  const { input } = attempt
  if (input.purpose === "junction") {
    await junctionSource(ports, input)
    return reviewJunctionInput(ports, attempt)
  }
  if (input.purpose !== "crossing") return
  // A changed receiving Train fails at promotion; don't spend a review on it.
  const train = await ports.store.train(input.trainId)
  if (!train || !crossingVisitMatches(train.value, input)) return
  await assertCrossing(ports, input)
  await reviewCrossingCandidate(ports, attempt, train.value.lineId)
}

async function reviewCrossingCandidate(
  ports: IntegrationPorts,
  attempt: IntegrationAttempt,
  receivingLineId: string
) {
  if (attempt.review) return
  const { input, candidate, evidence } = attempt
  if (!candidate || !evidence)
    throw new Error("No validated Crossing candidate")
  const crossing = input.crossingId
    ? (await ports.store.crossing(input.crossingId))?.value
    : undefined
  if (!crossing?.checkpoint) throw new Error("Crossing has no checkpoint")
  const snapshot = await ports.store.snapshot(input.networkId)
  if (!snapshot) throw new Error("Unknown network")
  const inspected = await ports.repositories.inspectIntegration?.(
    input,
    candidate
  )
  const conductor = await ports.conductorForTrain?.(
    input.trainId,
    input.conductorModel,
    input.junctionId
  )
  if (!inspected || !conductor?.reviewCrossing)
    throw new Error("Crossing review adapter is unavailable")
  await ports.store.recordIntegrationDiff(input.id, inspected.diff)
  const sourceCars = crossing.checkpoint.carIds.map((id) => {
    const c = snapshot.cars.find((c) => c.id === id)
    if (!c) throw new Error("Missing checkpoint Car")
    return c
  })
  const verdict = conductorVerdictSchema.parse(
    await conductor.reviewCrossing(
      {
        kind: "crossing",
        crossingId: crossing.id,
        sourceStationId: crossing.sourceStationId,
        sourceCommit: input.trainCommit,
        targetCommit: input.terminusCommit,
        candidateCommit: candidate.headCommit,
        ...inspected,
        evidence,
        sourceCars,
        receivingCars: snapshot.cars.filter((c) => c.trainId === input.trainId),
        downstreamManifests: snapshot.stations
          .filter(
            (s) =>
              s.lineId === receivingLineId &&
              s.state.status !== "complete" &&
              s.state.status !== "cancelled"
          )
          .map((s) => s.manifest),
      },
      { repoId: candidate.repoId, validation: input.validation }
    )
  )
  await ports.store.recordIntegrationReview(
    input.id,
    { ...verdict, ...conductor.config, model: conductor.model },
    inspected.diff
  )
}

async function reviewJunctionInput(
  ports: IntegrationPorts,
  attempt: IntegrationAttempt
) {
  if (attempt.review) return
  const { input, candidate, evidence } = attempt
  if (!candidate || !evidence)
    throw new Error("No validated Junction candidate")
  const j = (await ports.store.junction(input.junctionId!))!.value
  const snapshot = await ports.store.snapshot(input.networkId)
  if (!snapshot) throw new Error("Unknown network")
  const inspected = await ports.repositories.inspectIntegration?.(
    input,
    candidate
  )
  const conductor = await ports.conductorForTrain?.(
    input.trainId,
    input.conductorModel,
    input.junctionId
  )
  if (!inspected || !conductor?.reviewJunction)
    throw new Error("Junction review adapter unavailable")
  await ports.store.recordIntegrationDiff(input.id, inspected.diff)
  const train = await ports.store.train(input.trainId)
  const featureRepair = input.repairId
    ? (await ports.store.repair(input.repairId))?.value.source.kind ===
      "junction_feature"
    : false
  const sourceCars = snapshot.cars.filter((c) =>
    featureRepair
      ? j.inputs.some((i) => i.carIds.includes(c.id))
      : train?.value.carIds.includes(c.id)
  )
  const verdict = conductorVerdictSchema.parse(
    await conductor.reviewJunction(
      {
        kind: featureRepair ? "junction_feature" : "junction_input",
        junctionId: j.id,
        brief: j.brief,
        sourceCommit: input.trainCommit,
        targetCommit: input.terminusCommit,
        candidateCommit: candidate.headCommit,
        ...inspected,
        evidence,
        sourceCars,
        receivingCars: j.inputs.flatMap((i) =>
          i.carIds.map((id) => {
            const c = snapshot.cars.find((c) => c.id === id)
            if (!c) throw new Error("Missing Junction provenance")
            return c
          })
        ),
        repairIds: j.repairIds,
        ...(await (
          await import("./junction-operations")
        ).junctionReviewProvenance(ports, j)),
      },
      { repoId: candidate.repoId, validation: input.validation }
    )
  )
  await ports.store.recordIntegrationReview(
    input.id,
    { ...verdict, ...conductor.config, model: conductor.model },
    inspected.diff
  )
}
