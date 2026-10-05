import type { Car, ConductorReview } from "./car"
import type { Evidence } from "./evidence"
import { unmetRequiredChecks } from "./evidence"
import type { Issue } from "./issue"
import type { WorkManifest } from "./manifest"
import type { Train } from "./train"
import { accept, reject, type Transition } from "./transition"

export type LineOrigin =
  { kind: "depot" } | { kind: "junction"; junctionId: string }
export type LineDestination =
  { kind: "terminus" } | { kind: "junction"; junctionId: string }
export interface FeatureBrief {
  goal: string
  scope: string[]
  contracts: WorkManifest["contracts"]
  invariants: string[]
  acceptanceCriteria: string[]
  validation: { name: string; command: string[] }[]
}
export interface JunctionInput {
  trainId: string
  lineId: string
  sourceCommit: string
  integrationId: string
  mergeCommit: string
  carIds: string[]
}
export interface JunctionAcceptance {
  commit: string
  evidence: Evidence
  review: ConductorReview & { verdict: "accept" | "return" | "escalate" }
  diff: string
  changedPaths: string[]
}
export interface Junction {
  id: string
  networkId: string
  name: string
  repoId: string
  terminusBaseline: string
  headCommit: string
  incomingLineIds: string[]
  incomingTrainIds: string[]
  outgoingLineId: string
  outgoingTrainId: string
  outgoingUnloadMode: "auto" | "human_approval"
  brief: FeatureBrief
  conductorModel: string
  requestFingerprint?: string
  createdAt: string
  inputs: JunctionInput[]
  repairIds: string[]
  acceptance?: JunctionAcceptance
  attempt: number
  state:
    | { status: "collecting" }
    | { status: "reviewing" }
    | { status: "ready" }
    | { status: "released"; commit: string }
    | { status: "blocked"; issues: Issue[]; integrationId?: string }
    | { status: "abandoned"; reason: string }
}

export function createJunction(
  input: Omit<Junction, "inputs" | "repairIds" | "attempt" | "state">
): Transition<Junction> {
  if (
    input.incomingLineIds.length < 2 ||
    input.incomingLineIds.length !== input.incomingTrainIds.length ||
    new Set(input.incomingLineIds).size !== input.incomingLineIds.length ||
    new Set(input.incomingTrainIds).size !== input.incomingTrainIds.length ||
    input.incomingLineIds.includes(input.outgoingLineId) ||
    input.incomingTrainIds.includes(input.outgoingTrainId) ||
    input.headCommit !== input.terminusBaseline
  )
    return reject(
      "invalid_input",
      "A Junction needs distinct incoming Lines and one separate outgoing Line"
    )
  return accept(
    {
      ...input,
      inputs: [],
      repairIds: [],
      attempt: 0,
      state: { status: "collecting" },
    },
    [{ type: "junction.created", junctionId: input.id }]
  )
}
export function acceptJunctionInput(
  junction: Junction,
  input: JunctionInput,
  approval: {
    evidence: Evidence
    expectedChecks: string[]
    verdict: "accept" | "return" | "escalate"
  }
): Transition<Junction> {
  const saved = junction.inputs.find((i) => i.trainId === input.trainId)
  if (saved)
    return JSON.stringify(saved) === JSON.stringify(input)
      ? accept(junction, [])
      : reject(
          "invalid_input",
          "Input already accepted at a different snapshot"
        )
  if (
    junction.state.status !== "collecting" ||
    !junction.incomingTrainIds.includes(input.trainId) ||
    junction.incomingLineIds[
      junction.incomingTrainIds.indexOf(input.trainId)
    ] !== input.lineId
  )
    return reject("invalid_state", "Junction cannot accept this input")
  if (
    approval.verdict !== "accept" ||
    unmetRequiredChecks(approval.evidence, approval.expectedChecks).length
  )
    return reject(
      "required_checks_failed",
      "Junction input needs independent passing validation and accepted review"
    )
  return accept(
    {
      ...junction,
      headCommit: input.mergeCommit,
      inputs: [...junction.inputs, input],
    },
    [
      {
        type: "junction.input_accepted",
        junctionId: junction.id,
        trainId: input.trainId,
        integrationId: input.integrationId,
        mergeCommit: input.mergeCommit,
      },
    ]
  )
}
export function startJunctionReview(junction: Junction): Transition<Junction> {
  if (
    junction.state.status !== "collecting" ||
    junction.inputs.length !== junction.incomingTrainIds.length
  )
    return reject(
      "invalid_state",
      "Every declared input must be accepted before feature review"
    )
  return accept({ ...junction, state: { status: "reviewing" } }, [
    { type: "junction.review_started", junctionId: junction.id },
  ])
}
export function readyJunction(
  junction: Junction,
  acceptance: JunctionAcceptance,
  expectedChecks: string[]
): Transition<Junction> {
  if (
    junction.state.status !== "reviewing" ||
    acceptance.commit !== junction.headCommit
  )
    return reject(
      "invalid_state",
      "Feature review does not match the Junction snapshot"
    )
  if (
    acceptance.review.verdict !== "accept" ||
    unmetRequiredChecks(acceptance.evidence, expectedChecks).length
  )
    return reject(
      "required_checks_failed",
      "Feature acceptance requires passing validation and accepted review"
    )
  return accept({ ...junction, acceptance, state: { status: "ready" } }, [
    { type: "junction.ready", junctionId: junction.id },
  ])
}
export function releaseJunction(
  junction: Junction,
  commit: string
): Transition<Junction> {
  if (junction.state.status === "released")
    return junction.state.commit === commit
      ? accept(junction, [])
      : reject("stale_base", "Release approval is stale")
  if (
    junction.state.status !== "ready" ||
    commit !== junction.headCommit ||
    junction.acceptance?.commit !== commit ||
    junction.acceptance.review.verdict !== "accept"
  )
    return reject(
      "stale_base",
      "Release requires the exact accepted feature snapshot"
    )
  return accept({ ...junction, state: { status: "released", commit } }, [
    {
      type: "junction.released",
      junctionId: junction.id,
      trainId: junction.outgoingTrainId,
      mergeCommit: commit,
    },
  ])
}
export function blockJunction(
  junction: Junction,
  issues: Issue[],
  integrationId?: string
): Transition<Junction> {
  if (
    !issues.length ||
    ["released", "abandoned"].includes(junction.state.status)
  )
    return reject("invalid_state", "Cannot block this Junction")
  return accept(
    {
      ...junction,
      state: {
        status: "blocked",
        issues,
        ...(integrationId ? { integrationId } : {}),
      },
    },
    [
      { type: "junction.blocked", junctionId: junction.id, issues },
      {
        type: "dispatcher.junction_attention_requested",
        junctionId: junction.id,
        issues,
      },
    ]
  )
}
export function retryJunction(junction: Junction): Transition<Junction> {
  if (junction.state.status !== "blocked")
    return reject("invalid_state", "Junction is not blocked")
  return accept(
    {
      ...junction,
      attempt: junction.attempt + 1,
      acceptance: undefined,
      state: { status: "collecting" },
    },
    [{ type: "junction.retried", junctionId: junction.id }]
  )
}
export function abandonJunction(
  junction: Junction,
  reason: string
): Transition<Junction> {
  if (junction.state.status === "abandoned") return accept(junction, [])
  if (junction.state.status === "released" || !reason.trim())
    return reject("invalid_state", "Cannot abandon a released Junction")
  return accept({ ...junction, state: { status: "abandoned", reason } }, [
    { type: "junction.abandoned", junctionId: junction.id },
  ])
}
export function junctionCars(junction: Junction, cars: Car[]): Car[] {
  const seen = new Set<string>()
  return junction.inputs
    .flatMap((input) =>
      input.carIds.map((id) => {
        const car = cars.find((c) => c.id === id && c.trainId === input.trainId)
        if (!car) throw new Error(`Missing Junction Car ${id}`)
        return car
      })
    )
    .filter((car) => {
      const id = car.originCarId ?? car.id
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
}
export function copyJunctionCars(
  junction: Junction,
  cars: Car[],
  at: string
): Car[] {
  return junctionCars(junction, cars).map((car, i) => ({
    ...car,
    id: `${junction.id}-car-${car.originCarId ?? car.id}`,
    trainId: junction.outgoingTrainId,
    position: i + 1,
    originCarId: car.originCarId ?? car.id,
    sourceCarId: car.id,
    crossingId: undefined,
    junctionId: junction.id,
    copiedAt: at,
  }))
}
export function isCanonicalUnload(train: Train): boolean {
  return (
    train.state.status === "unloaded" &&
    train.state.destination?.kind !== "junction"
  )
}
