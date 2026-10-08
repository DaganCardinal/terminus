import { describe, expect, it } from "vitest"
import type { Conflict } from "./conflict"
import {
  confidentChoice,
  REVISION_ACTIONS,
  STATION_FAILURE_ACTIONS,
  evaluateDeparture,
  evaluateTerminusEntry,
  evaluateStationRetry,
  shouldNotifyDispatcher,
  signalFor,
} from "./engineer"
import type { Hold } from "./hold"
import { atDepot, clearContext, manifest } from "./testing"
import type { Train } from "./train"

const { train, station } = atDepot()
const dependent = { ...station, manifest: manifest({ dependencies: ["x1"] }) }

const conflict: Conflict = {
  id: "c1",
  trainIds: [train.id],
  paths: ["src/a.ts"],
  description: "overlapping edits",
  status: "open",
}

const hold = (scope: Hold["scope"], kind: Hold["kind"] = "user"): Hold => ({
  id: "h1",
  kind,
  scope,
  note: "",
})

describe("evaluateStationRetry", () => {
  it.each([0, 1, 2])("permits retry after %i revisions", (retryCount) => {
    expect(evaluateStationRetry({ ...station, retryCount })).toEqual({
      kind: "clear",
    })
  })
  it.each([3, 4])(
    "blocks after %i revisions with the default allowance",
    (retryCount) => {
      expect(evaluateStationRetry({ ...station, retryCount })).toMatchObject({
        kind: "block",
        issues: [{ kind: "station_retries_exhausted" }],
      })
    }
  )
  it("honors zero and custom allowances", () => {
    expect(evaluateStationRetry(station, 0).kind).toBe("block")
    expect(evaluateStationRetry({ ...station, retryCount: 3 }, 4).kind).toBe(
      "clear"
    )
  })
  it("counts legacy records and grants a new allowance after explicit reset", () => {
    expect(
      evaluateStationRetry({
        ...station,
        retryCount: undefined,
        revisionCount: 3,
      }).kind
    ).toBe("block")
    expect(
      evaluateStationRetry({ ...station, retryCount: 0, revisionCount: 3 }).kind
    ).toBe("clear")
  })
  it.each([-1, 1.5, NaN, Infinity])(
    "rejects invalid allowances: %s",
    (maxRetries) => {
      expect(() => evaluateStationRetry(station, maxRetries)).toThrow(
        RangeError
      )
    }
  )
})

describe("evaluateDeparture", () => {
  it("blocks absent, verification-only and empty deliverables before signaling", () => {
    for (const work of [
      manifest({ repositoryChange: undefined }),
      manifest({
        repositoryChange: {
          kind: "verification",
          description: "Run existing tests",
        },
      }),
      manifest({ repositoryChange: { kind: "tests", description: " " } }),
      manifest({ expectedAreas: [] }),
    ]) {
      expect(
        evaluateDeparture(train, { ...station, manifest: work }, clearContext())
      ).toMatchObject({
        kind: "block",
        issues: [{ kind: "station_change_required" }],
      })
    }
    expect(
      evaluateDeparture(
        train,
        {
          ...station,
          manifest: manifest({
            repositoryChange: {
              kind: "tests",
              description: "Add regression tests",
            },
          }),
        },
        clearContext()
      ).kind
    ).toBe("clear")
  })
  it("clears when no hard rule applies", () => {
    expect(evaluateDeparture(train, station, clearContext())).toEqual({
      kind: "clear",
    })
  })

  it("blocks when required tests failed", () => {
    const decision = evaluateDeparture(
      train,
      station,
      clearContext({
        trainChecks: [
          { name: "test", required: true, status: "failed" },
          { name: "lint", required: false, status: "failed" },
        ],
      })
    )
    expect(decision).toMatchObject({
      kind: "block",
      issues: [{ kind: "required_checks_failed" }],
    })
  })

  it("blocks when a required check was skipped", () => {
    const decision = evaluateDeparture(
      train,
      station,
      clearContext({
        trainChecks: [{ name: "test", required: true, status: "skipped" }],
      })
    )
    expect(decision.kind).toBe("block")
  })

  it("blocks on an unresolved conflict involving the Train", () => {
    expect(
      evaluateDeparture(train, station, clearContext({ conflicts: [conflict] }))
    ).toMatchObject({ kind: "block", issues: [{ kind: "conflict" }] })
  })

  it("ignores resolved conflicts and other Trains' conflicts", () => {
    const conflicts: Conflict[] = [
      { ...conflict, status: "resolved" },
      { ...conflict, id: "c2", trainIds: ["someone-else"] },
    ]
    expect(
      evaluateDeparture(train, station, clearContext({ conflicts })).kind
    ).toBe("clear")
  })

  it("holds while a dependency is incomplete", () => {
    expect(
      evaluateDeparture(
        train,
        dependent,
        clearContext({ dependencies: { x1: "active" } })
      )
    ).toEqual({
      kind: "hold",
      reasons: [{ kind: "dependency", stationId: "x1" }],
    })
  })

  it("clears once the dependency is complete", () => {
    expect(
      evaluateDeparture(
        train,
        dependent,
        clearContext({ dependencies: { x1: "complete" } })
      ).kind
    ).toBe("clear")
  })

  it.each(["cancelled", undefined] as const)(
    "blocks when a dependency is %s",
    (status) => {
      expect(
        evaluateDeparture(
          train,
          dependent,
          clearContext({ dependencies: status ? { x1: status } : {} })
        )
      ).toMatchObject({
        kind: "block",
        issues: [{ kind: "dependency_unresolvable" }],
      })
    }
  )

  it.each([
    [{ kind: "network" as const }],
    [{ kind: "line" as const, lineId: train.lineId }],
    [{ kind: "train" as const, trainId: train.id }],
  ])("holds for a user hold scoped to %o", (scope) => {
    expect(
      evaluateDeparture(train, station, clearContext({ holds: [hold(scope)] }))
    ).toEqual({ kind: "hold", reasons: [{ kind: "user_hold", holdId: "h1" }] })
  })

  it("holds for Dispatcher sequencing", () => {
    expect(
      evaluateDeparture(
        train,
        station,
        clearContext({ holds: [hold({ kind: "network" }, "sequencing")] })
      )
    ).toEqual({ kind: "hold", reasons: [{ kind: "sequencing", holdId: "h1" }] })
  })

  it("ignores holds on other Lines and Trains", () => {
    const holds = [
      hold({ kind: "line", lineId: "blue" }),
      hold({ kind: "train", trainId: "other" }),
    ]
    expect(
      evaluateDeparture(train, station, clearContext({ holds })).kind
    ).toBe("clear")
  })

  it("blocks rather than holds when both apply", () => {
    expect(
      evaluateDeparture(
        train,
        station,
        clearContext({
          holds: [hold({ kind: "network" })],
          conflicts: [conflict],
        })
      ).kind
    ).toBe("block")
  })
})

describe("evaluateTerminusEntry", () => {
  it("clears, holds, and blocks like departure", () => {
    expect(evaluateTerminusEntry(train, clearContext()).kind).toBe("clear")
    expect(
      evaluateTerminusEntry(
        train,
        clearContext({ holds: [hold({ kind: "network" }, "sequencing")] })
      ).kind
    ).toBe("hold")
    expect(
      evaluateTerminusEntry(train, clearContext({ conflicts: [conflict] })).kind
    ).toBe("block")
  })
})

describe("signalFor", () => {
  const withState = (state: Train["state"]): Train => ({ ...train, state })

  it("is red when held or blocked", () => {
    const resume = train.state as Extract<Train["state"], { status: "ready" }>
    expect(signalFor(withState({ status: "held", reasons: [], resume }))).toBe(
      "red"
    )
    expect(
      signalFor(withState({ status: "blocked", issues: [], resume }))
    ).toBe("red")
  })

  it("is green while running and absent once terminal", () => {
    expect(signalFor(train)).toBe("green")
    expect(signalFor(withState({ status: "siding", reason: "" }))).toBeNull()
    expect(
      signalFor(withState({ status: "unloaded", mergeCommit: "m" }))
    ).toBeNull()
  })
})

describe("confidentChoice", () => {
  const failure = (probabilities: Record<string, number> | null) =>
    confidentChoice(probabilities, STATION_FAILURE_ACTIONS, "escalate")
  it("acts on a confident answer", () => {
    expect(failure({ retry: 0.8, wait: 0.15, escalate: 0.05 })).toBe("retry")
    expect(failure({ retry: 0.1, wait: 0.7, escalate: 0.2 })).toBe("wait")
  })
  it("keeps the deterministic default when no option clears the threshold", () => {
    expect(failure({ retry: 0.5, wait: 0.4, escalate: 0.1 })).toBe("escalate")
    expect(
      confidentChoice(
        { revise: 0.4, escalate: 0.6 },
        REVISION_ACTIONS,
        "revise"
      )
    ).toBe("revise")
  })
  it("keeps the default without an answer", () => {
    expect(failure(null)).toBe("escalate")
    expect(confidentChoice({}, REVISION_ACTIONS, "revise")).toBe("revise")
  })
  it("honors a custom threshold", () => {
    expect(
      confidentChoice(
        { revise: 0.5, escalate: 0.5 },
        REVISION_ACTIONS,
        "escalate",
        0.5
      )
    ).toBe("revise")
  })
})

describe("shouldNotifyDispatcher", () => {
  it("stays quiet only on a confident no", () => {
    expect(shouldNotifyDispatcher(0.1)).toBe(false)
    expect(shouldNotifyDispatcher(0.3)).toBe(false)
  })
  it("notifies on a likely yes or on doubt", () => {
    expect(shouldNotifyDispatcher(0.9)).toBe(true)
    expect(shouldNotifyDispatcher(0.5)).toBe(true)
  })
  it("notifies without an answer", () => {
    expect(shouldNotifyDispatcher(null)).toBe(true)
  })
})
