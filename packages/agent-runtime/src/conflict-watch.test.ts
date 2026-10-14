import { describe, expect, it, vi } from "vitest"
import {
  DISPATCHER_QUESTIONS,
  FakeConflictInvestigator,
  FakeConflictTriage,
  HarnessConflictInvestigator,
  ModelConflictTriage,
  type ConflictInvestigationInput,
  type ConflictSession,
  type ConflictSituation,
} from "./conflict-watch"

const side = (trainId: string, lineName: string) => ({
  trainId,
  lineName,
  cars: [],
  upcoming: [],
})

const situation = (
  overlap: Partial<ConflictSituation["overlap"]> = {}
): ConflictSituation => ({
  car: {
    stationName: "Login",
    goal: "Change login",
    changedPaths: ["src/api/login.ts"],
    contracts: [],
    invariants: [],
    summary: "Authorization: Bearer abc.def",
  },
  train: side("a", "Auth"),
  other: side("b", "Profile"),
  overlap: {
    sharedPaths: [],
    plannedAreas: [],
    sharedContracts: [],
    sharedDirectories: [],
    ...overlap,
  },
})

const input = (s = situation()): ConflictInvestigationInput => ({
  id: "watch-car-a-b",
  situation: s,
  repositories: {
    train: { repoId: "a", commit: "1".repeat(40) },
    other: { repoId: "b", commit: "2".repeat(40) },
  },
  validation: [],
})

function session(
  answers: string[],
  trialMerge = { clean: true, conflictPaths: [] as string[] }
) {
  const value = {
    prepare: vi.fn(async () => ({ trialMerge, checks: [] })),
    start: vi.fn<ConflictSession["start"]>(async () => answers.shift() ?? ""),
    resume: vi.fn<ConflictSession["resume"]>(async () => answers.shift() ?? ""),
    close: vi.fn(async () => {}),
  } satisfies ConflictSession
  return { value, sessions: { open: () => value } }
}

describe("Dispatcher Clef triage", () => {
  it("investigates only when a conflict is more likely than not, with redacted state", async () => {
    const decide = vi.fn(async () => ({
      conflict_risk: { type: "noul" as const, noul: 0.8 },
    }))
    const triage = new ModelConflictTriage("clef", { decide })
    expect(await triage.conflictRisk(situation())).toEqual({
      likely: true,
      probability: 0.8,
      model: "clef",
    })
    const request = (decide.mock.calls[0] as unknown[])[0] as {
      role: string
      state: ConflictSituation
      questions: unknown
    }
    expect(request.role).toBe("dispatcher")
    expect(request.questions).toEqual(DISPATCHER_QUESTIONS)
    expect(request.state.car.summary).not.toContain("abc.def")
  })

  it("does not investigate when Clef gives no answer", async () => {
    const triage = new ModelConflictTriage("clef", {
      decide: async () => {
        throw new Error("Gateway down")
      },
    })
    expect(await triage.conflictRisk(situation())).toEqual({
      likely: false,
      probability: null,
      model: "clef",
      error: "Gateway down",
    })
  })

  it("simulates relatedness offline from shared directories", async () => {
    const fake = new FakeConflictTriage()
    expect((await fake.conflictRisk(situation())).likely).toBe(false)
    expect(
      (await fake.conflictRisk(situation({ sharedDirectories: ["src/api"] })))
        .likely
    ).toBe(true)
  })
})

describe("Dispatcher conflict investigation", () => {
  it("returns the model's verdict with the trial merge", async () => {
    const { value, sessions } = session([
      'Done.\n```json\n{"conflict": true, "summary": "Profile reads a field Auth removed.", "paths": ["src/api/login.ts"], "details": ["login() no longer returns user.id"], "suggestedHold": "other"}\n```',
    ])
    const investigator = new HarnessConflictInvestigator("model", sessions)
    const result = await investigator.investigate(input())
    expect(result).toEqual({
      trialMerge: { clean: true, conflictPaths: [] },
      checks: [],
      verdict: {
        conflict: true,
        summary: "Profile reads a field Auth removed.",
        paths: ["src/api/login.ts"],
        details: ["login() no longer returns user.id"],
        suggestedHold: "other",
      },
    })
    expect(value.start.mock.calls[0]![1]).toContain("Trial merge: clean.")
    expect(value.close).toHaveBeenCalled()
  })

  it("asks once for a corrected answer", async () => {
    const { value, sessions } = session([
      "I think they are fine",
      '{"conflict": false, "summary": "Independent changes."}',
    ])
    const result = await new HarnessConflictInvestigator(
      "model",
      sessions
    ).investigate(input())
    expect(value.resume).toHaveBeenCalledTimes(1)
    expect(result.verdict).toMatchObject({
      conflict: false,
      suggestedHold: "none",
    })
  })

  it("keeps a conflicted trial merge when the model never answers properly", async () => {
    const { sessions } = session(["nope", "still nope"], {
      clean: false,
      conflictPaths: ["src/api/login.ts"],
    })
    const result = await new HarnessConflictInvestigator(
      "model",
      sessions
    ).investigate(input())
    expect(result.verdict).toMatchObject({
      conflict: true,
      paths: ["src/api/login.ts"],
    })
  })

  it("fails when a clean merge never gets a valid answer, and still closes", async () => {
    const { value, sessions } = session(["nope", "still nope"])
    await expect(
      new HarnessConflictInvestigator("model", sessions).investigate(input())
    ).rejects.toThrow("Investigation answer was invalid")
    expect(value.close).toHaveBeenCalled()
  })

  it("simulates offline from shared files only", async () => {
    const fake = new FakeConflictInvestigator()
    expect((await fake.investigate(input())).verdict.conflict).toBe(false)
    expect(
      (
        await fake.investigate(
          input(situation({ sharedPaths: ["src/api/login.ts"] }))
        )
      ).verdict
    ).toMatchObject({ conflict: true, paths: ["src/api/login.ts"] })
  })
})
