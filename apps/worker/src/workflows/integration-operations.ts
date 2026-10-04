import {
  evaluateTerminusEntry,
  unmetRequiredChecks,
  type Evidence,
} from "@terminus/domain"
import type { RepositoryHost } from "@terminus/artifacts"
import {
  evidenceSchema,
  type IntegrationAttempt,
  type IntegrationResult,
} from "@terminus/protocol"
import type { NetworkStore } from "../integrations/network-store"
import type { IntegrationValidator } from "../integrations/integration-validator"

export interface IntegrationPorts {
  store: NetworkStore
  repositories: RepositoryHost
  validator: IntegrationValidator
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
  const attempt = await load(ports, id)
  if (attempt.status !== "cleared") return
  const { input } = attempt
  const train = await ports.store.train(input.trainId)
  if (
    !train ||
    train.value.headCommit !== input.trainCommit ||
    train.value.state.status !== "returning" ||
    train.value.state.phase !== "integrating"
  )
    throw new Error("Train no longer matches Dispatcher clearance")
  const merged = await ports.repositories.prepareIntegration(input)
  if (!merged.ok) {
    await ports.store.finishIntegration(id, {
      ok: false,
      issues: [
        {
          kind: "conflict",
          detail: `Terminus merge conflicts: ${merged.conflictPaths.join(", ")}`,
        },
      ],
      conflictPaths: merged.conflictPaths,
    })
    return
  }
  const evidence = evidenceSchema.parse(
    await ports.validator.validate(merged.candidate, input.validation)
  )
  await ports.store.prepareIntegration(id, merged.candidate, evidence)
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
  if (head === candidate.headCommit) return complete(ports, attempt, evidence)
  const train = await ports.store.train(input.trainId)
  if (
    !train ||
    train.value.headCommit !== input.trainCommit ||
    train.value.state.status !== "returning" ||
    train.value.state.phase !== "integrating"
  )
    throw new Error("Train changed before Terminus promotion")
  const gate = evaluateTerminusEntry(train.value, {
    holds: await ports.store.holds(input.networkId),
    conflicts: await ports.store.conflicts(input.networkId),
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
    if (head === attempt.candidate!.headCommit)
      return complete(ports, attempt, attempt.evidence!)
  }
  const result: IntegrationResult = {
    ok: false,
    issues: [{ kind: "integration_failed", detail }],
  }
  await ports.store.finishIntegration(id, result)
  return result
}
