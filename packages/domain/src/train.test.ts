import { describe, expect, it } from "vitest"
import type { HoldReason } from "./hold"
import {
  accepted,
  active,
  approaching,
  atDepot,
  docked,
  eventTypes,
  expectRejected,
  inTransit,
  reviewing,
  unwrap,
} from "./testing"
import {
  blockTrain,
  clearTrainBlock,
  holdTrain,
  releaseTrain,
  sendToSiding,
  type Train,
} from "./train"

const userHold: HoldReason = { kind: "user_hold", holdId: "h1" }
const issue = { kind: "needs_user" as const, detail: "which API shape?" }

describe("createTrain", () => {
  it("starts ready at the depot, forked from Terminus", () => {
    const { train } = atDepot()
    expect(train.state).toEqual({ status: "ready", at: { kind: "depot" } })
    expect(train.terminusBaseline).toBe("t0")
    expect(train.headCommit).toBe("t0")
    expect(train.carIds).toEqual([])
  })
})

describe("holdTrain and releaseTrain", () => {
  it("holds a ready Train and releases it back to the same place", () => {
    const { train } = accepted()
    const held = holdTrain(train, [userHold])
    expect(unwrap(held).state).toEqual({
      status: "held",
      reasons: [userHold],
      resume: { status: "ready", at: { kind: "station", stationId: "s1" } },
    })
    expect(eventTypes(held)).toEqual(["train.held"])

    const released = releaseTrain(unwrap(held))
    expect(unwrap(released).state).toEqual(train.state)
    expect(eventTypes(released)).toEqual(["train.released"])
  })

  it("holds a returning Train waiting for clearance", () => {
    const returning: Train = {
      ...atDepot().train,
      state: { status: "returning", phase: "awaiting_clearance" },
    }
    const held = unwrap(holdTrain(returning, [userHold]))
    expect(unwrap(releaseTrain(held)).state).toEqual(returning.state)
  })

  it("rejects holding a Train that is not at a gate", () => {
    expectRejected(holdTrain(inTransit().train, [userHold]), "invalid_state")
    expectRejected(
      holdTrain(
        {
          ...atDepot().train,
          state: { status: "returning", phase: "integrating" },
        },
        [userHold]
      ),
      "invalid_state"
    )
  })

  it("rejects holding without a reason", () => {
    expectRejected(holdTrain(atDepot().train, []), "invalid_input")
  })

  it("rejects releasing a Train that is not held", () => {
    expectRejected(releaseTrain(atDepot().train), "invalid_state")
  })
})

describe("blockTrain and clearTrainBlock", () => {
  it("raises the issue to the Dispatcher", () => {
    const result = blockTrain(atDepot().train, [issue])
    expect(eventTypes(result)).toEqual(["train.blocked", "train.issue_raised"])
  })

  it.each([
    ["in transit", inTransit],
    ["approaching", approaching],
    ["docked", docked],
    ["reviewing", reviewing],
  ])("resumes a Train blocked while %s at its last stop", (_, reach) => {
    const { train } = reach()
    const blocked = unwrap(blockTrain(train, [issue]))
    const cleared = clearTrainBlock(blocked)
    expect(unwrap(cleared).state).toEqual({
      status: "ready",
      at: { kind: "depot" },
    })
    expect(eventTypes(cleared)).toEqual(["train.cleared"])
  })

  it("resumes a held Train's gate when cleared", () => {
    const held = unwrap(holdTrain(atDepot().train, [userHold]))
    const blocked = unwrap(blockTrain(held, [issue]))
    expect(unwrap(clearTrainBlock(blocked)).state).toEqual({
      status: "ready",
      at: { kind: "depot" },
    })
  })

  it("resumes a Train blocked during integration to await clearance", () => {
    const integrating: Train = {
      ...atDepot().train,
      state: { status: "returning", phase: "integrating" },
    }
    const blocked = unwrap(blockTrain(integrating, [issue]))
    expect(unwrap(clearTrainBlock(blocked)).state).toEqual({
      status: "returning",
      phase: "awaiting_clearance",
    })
  })

  it("rejects blocking without an issue", () => {
    expectRejected(blockTrain(active().train, []), "invalid_input")
  })

  it("rejects blocking an already blocked or terminal Train", () => {
    const blocked = unwrap(blockTrain(atDepot().train, [issue]))
    expectRejected(blockTrain(blocked, [issue]), "invalid_state")
    const sided = unwrap(sendToSiding(atDepot().train, "abandoned"))
    expectRejected(blockTrain(sided, [issue]), "invalid_state")
  })

  it("rejects clearing a Train that is not blocked", () => {
    expectRejected(clearTrainBlock(atDepot().train), "invalid_state")
  })
})

describe("sendToSiding", () => {
  it("parks a running Train on the siding", () => {
    const result = sendToSiding(inTransit().train, "superseded")
    expect(unwrap(result).state).toEqual({
      status: "siding",
      reason: "superseded",
    })
    expect(eventTypes(result)).toEqual(["train.sided"])
  })

  it("rejects siding a terminal Train", () => {
    const sided = unwrap(sendToSiding(atDepot().train, "abandoned"))
    expectRejected(sendToSiding(sided, "again"), "invalid_state")
  })
})
