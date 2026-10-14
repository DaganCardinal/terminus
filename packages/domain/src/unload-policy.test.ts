import { describe, expect, it } from "vitest"
import { evaluateDeparture, evaluateTerminusEntry } from "./engineer"
import {
  approveTrainUnload,
  changeUnloadMode,
  hasUnloadPermission,
  isAwaitingUnloadApproval,
  type TrainUnloadPolicy,
} from "./unload-policy"
import { holdTrain, type Train } from "./train"
import { atDepot, clearContext, expectRejected, unwrap } from "./testing"
import {
  createDispatchPlan,
  readyDispatchPlan,
  selectPlannedUnloadMode,
} from "./dispatch-plan"
import { manifest } from "./testing"

const now = "2026-10-04T12:00:00.000Z"
const returning = (): Train => ({
  ...atDepot().train,
  state: { status: "returning", phase: "awaiting_clearance" },
})
const manual = (train: Train): TrainUnloadPolicy => ({
  trainId: train.id,
  mode: "human_approval",
})

describe("human unloading permission", () => {
  it("gates only Terminus entry, keeping normal Station execution automatic", () => {
    const { train, station } = atDepot()
    const context = clearContext({ unloadPolicy: manual(train) })
    expect(evaluateDeparture(train, station, context)).toEqual({
      kind: "clear",
    })
    expect(evaluateTerminusEntry(train, context)).toEqual({
      kind: "hold",
      reasons: [
        { kind: "awaiting_user_approval", trainCommit: train.headCommit },
      ],
    })
    expect(evaluateTerminusEntry(train, clearContext())).toEqual({
      kind: "clear",
    })
    expect(
      evaluateTerminusEntry(
        train,
        clearContext({ unloadPolicy: { ...manual(train), mode: "auto" } })
      )
    ).toEqual({ kind: "clear" })
    expect(
      hasUnloadPermission(train, { ...manual(train), trainId: "another" })
    ).toBe(false)
  })

  it("records approval of the exact completed Train and invalidates permission when it changes", () => {
    const train = returning()
    const approved = approveTrainUnload(
      train,
      manual(train),
      train.headCommit,
      now
    )
    expect(approved.ok && approved.events).toEqual([
      {
        type: "train.unload_approved",
        trainId: train.id,
        trainCommit: train.headCommit,
        approvedAt: now,
      },
    ])
    const policy = unwrap(approved)
    expect(hasUnloadPermission(train, policy)).toBe(true)
    expect(hasUnloadPermission({ ...train, headCommit: "new" }, policy)).toBe(
      false
    )
    expect(
      approveTrainUnload(train, policy, train.headCommit, now)
    ).toMatchObject({ ok: true, events: [] })
    expectRejected(
      approveTrainUnload(train, policy, "stale", now),
      "invalid_input"
    )
    expectRejected(
      approveTrainUnload(atDepot().train, manual(train), train.headCommit, now),
      "invalid_state"
    )
    expectRejected(
      approveTrainUnload(
        train,
        { ...policy, mode: "auto" },
        train.headCommit,
        now
      ),
      "invalid_input"
    )
    expectRejected(
      approveTrainUnload(
        { ...train, state: { status: "returning", phase: "integrating" } },
        policy,
        train.headCommit,
        now
      ),
      "invalid_state"
    )
  })

  it("cannot override failed checks or user holds, and refreshes remaining hold reasons", () => {
    const train = returning()
    const policy = unwrap(
      approveTrainUnload(train, manual(train), train.headCommit, now)
    )
    expect(
      evaluateTerminusEntry(
        train,
        clearContext({
          unloadPolicy: policy,
          trainChecks: [{ name: "test", required: true, status: "failed" }],
        })
      ).kind
    ).toBe("block")
    const context = clearContext({
      unloadPolicy: manual(train),
      holds: [
        {
          id: "h",
          kind: "user",
          scope: { kind: "train", trainId: train.id },
          note: "Wait",
        },
      ],
    })
    const decision = evaluateTerminusEntry(train, context)
    if (decision.kind !== "hold") throw new Error("Expected hold")
    const held = unwrap(holdTrain(train, decision.reasons))
    expect(isAwaitingUnloadApproval(held)).toBe(true)
    const approvedHeld = unwrap(
      approveTrainUnload(held, manual(train), train.headCommit, now)
    )
    const remaining = evaluateTerminusEntry(held, {
      ...context,
      unloadPolicy: approvedHeld,
    })
    if (remaining.kind !== "hold") throw new Error("Expected user hold")
    const refreshed = holdTrain(held, remaining.reasons)
    expect(isAwaitingUnloadApproval(unwrap(refreshed))).toBe(false)
    expect(holdTrain(unwrap(refreshed), remaining.reasons)).toMatchObject({
      ok: true,
      events: [],
    })
  })

  it("preserves recommendations, clears approval on mode changes, and closes terminal selections", () => {
    const train = returning()
    const policy = {
      ...unwrap(
        approveTrainUnload(train, manual(train), train.headCommit, now)
      ),
      recommendation: { mode: "human_approval" as const, reason: "Preview" },
    }
    const auto = unwrap(changeUnloadMode(train, policy, "auto"))
    expect(auto.approval).toBeUndefined()
    expect(auto.recommendation).toEqual(policy.recommendation)
    expect(changeUnloadMode(train, auto, "auto")).toMatchObject({
      ok: true,
      events: [],
    })
    expect(
      hasUnloadPermission(
        train,
        unwrap(changeUnloadMode(train, auto, "human_approval"))
      )
    ).toBe(false)
    expectRejected(
      changeUnloadMode(train, { ...policy, trainId: "other" }, "auto"),
      "invalid_input"
    )
    for (const state of [
      { status: "unloaded" as const, mergeCommit: "m" },
      { status: "siding" as const, reason: "abandoned" },
      { status: "returning" as const, phase: "integrating" as const },
    ])
      expectRejected(
        changeUnloadMode({ ...train, state }, policy, "auto"),
        "invalid_state"
      )
  })

  it("allows users to override a ready proposal without changing its recommendation", () => {
    const plan = unwrap(
      createDispatchPlan({
        id: "plan",
        networkId: "n",
        goal: "Build",
        terminusCommit: "base",
        model: "fake",
        createdAt: now,
      })
    )
    const ready = unwrap(
      readyDispatchPlan(
        plan,
        {
          summary: "Build",
          lines: [
            {
              key: "line",
              name: "Line",
              unloadRecommendation: {
                mode: "human_approval",
                reason: "Preview",
              },
              stations: [
                {
                  key: "s",
                  name: "S",
                  manifest: manifest({ expectedEvidence: [] }),
                },
              ],
            },
          ],
        },
        { projectChecks: [], activeLines: [] }
      )
    )
    const selected = unwrap(selectPlannedUnloadMode(ready, "line", "auto"))
    expect(selected.state).toMatchObject({
      proposal: {
        lines: [
          {
            unloadMode: "auto",
            unloadRecommendation: { mode: "human_approval" },
          },
        ],
      },
    })
    expect(selectPlannedUnloadMode(selected, "line", "auto")).toMatchObject({
      ok: true,
      events: [],
    })
    expectRejected(
      selectPlannedUnloadMode(plan, "line", "auto"),
      "invalid_state"
    )
    expectRejected(
      selectPlannedUnloadMode(ready, "missing", "auto"),
      "invalid_input"
    )
  })
})
