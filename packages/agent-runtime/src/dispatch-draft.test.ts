import { describe, expect, it } from "vitest"
import { z } from "zod"
import type { BaselineReport } from "@terminus/domain"
import {
  dispatchProposalSchema,
  planLimits,
  type PlanDraft,
} from "@terminus/protocol"
import {
  emptyPlanDraft,
  planAcceptedReply,
  planToolNames,
  planToolReply,
  planTools,
  reviewPlanDraft,
  type PlanCheckContext,
  type PlanToolReply,
} from "./dispatch-draft"

const context: PlanCheckContext = {
  network: {
    projectChecks: [{ name: "test", command: ["npm", "test"] }],
    activeLines: [],
  },
  baseline: null,
}

const auto = { mode: "auto", reason: "A small, bounded change." }

function station(key: string, fields: Record<string, unknown> = {}) {
  return {
    key,
    name: `Station ${key}`,
    goal: `Deliver ${key}`,
    changeKind: "implementation",
    changeDescription: `Implement ${key}`,
    scope: [`Only the ${key} behavior`],
    expectedAreas: [`src/${key}.ts`],
    invariants: ["Existing behavior stays intact"],
    acceptanceCriteria: [`${key} works`],
    expectedEvidence: ["test"],
    ...fields,
  }
}

const outline = {
  summary: "Two independent Lines.",
  lines: [
    {
      key: "alpha",
      name: "Alpha",
      unloadRecommendation: auto,
      stations: ["a1", "a2"],
      shared: {
        invariants: ["Everything stays client-side"],
        expectedEvidence: ["test"],
      },
    },
    {
      key: "beta",
      name: "Beta",
      unloadRecommendation: auto,
      stations: ["b1"],
    },
  ],
}

type Call = [name: string, args: unknown]

/** Runs calls in order, carrying the draft from each reply to the next. */
function run(
  calls: Call[],
  draft: PlanDraft = emptyPlanDraft,
  check: PlanCheckContext = context
): { replies: PlanToolReply[]; draft: PlanDraft } {
  const replies: PlanToolReply[] = []
  for (const [name, args] of calls) {
    const reply = planToolReply(name, args, draft, check)
    replies.push(reply)
    draft = reply.draft
  }
  return { replies, draft }
}

const put = (args: unknown): Call => [planToolNames.station, args]
const setOutline = (args: unknown): Call => [
  planToolNames.outline,
  { outline: args },
]
const finalize: Call = [planToolNames.finalize, {}]
const complete: Call[] = [
  setOutline(outline),
  put(station("a1", { invariants: ["a1 keeps its API"] })),
  put(station("a2", { invariants: [], expectedEvidence: [] })),
  put(station("b1")),
]

describe("plan assembly", () => {
  it("assembles the proposal in code from the outline and Stations, in any order", () => {
    const { replies } = run([
      put(station("b1")),
      put(station("a2", { invariants: [], expectedEvidence: [] })),
      setOutline(outline),
      put(station("a1", { invariants: ["a1 keeps its API"] })),
      finalize,
    ])
    const accepted = replies.at(-1)!
    expect(accepted.outcome).toBe("accepted")
    expect(accepted.text.startsWith(planAcceptedReply)).toBe(true)
    expect(dispatchProposalSchema.parse(accepted.proposal)).toEqual(
      accepted.proposal
    )
    const [alpha, beta] = accepted.proposal!.lines
    expect(alpha).toMatchObject({
      key: "alpha",
      name: "Alpha",
      unloadRecommendation: auto,
    })
    expect(alpha!.stations.map((s) => s.key)).toEqual(["a1", "a2"])
    // Line-shared values come first and appear once.
    expect(alpha!.stations[0]!.manifest).toEqual({
      goal: "Deliver a1",
      repositoryChange: { kind: "implementation", description: "Implement a1" },
      scope: ["Only the a1 behavior"],
      expectedAreas: ["src/a1.ts"],
      avoidAreas: [],
      contracts: [],
      invariants: ["Everything stays client-side", "a1 keeps its API"],
      dependencies: [],
      acceptanceCriteria: ["a1 works"],
      expectedEvidence: ["test"],
    })
    expect(alpha!.stations[1]!.manifest.invariants).toEqual([
      "Everything stays client-side",
    ])
    expect(beta!.stations[0]!.manifest.invariants).toEqual([
      "Existing behavior stays intact",
    ])
    expect(accepted.proposal).not.toHaveProperty("junctions")
  })

  it("reviews a complete draft exactly as finalize does", () => {
    const { draft } = run(complete)
    const review = reviewPlanDraft(draft, context)
    expect(review.kind).toBe("valid")
    const finalized = planToolReply(planToolNames.finalize, {}, draft, context)
    expect(review).toEqual({ kind: "valid", proposal: finalized.proposal })
  })

  it("places Junction Lines in their Junction and merges their shared values", () => {
    const junctionOutline = {
      summary: "A feature built in a Junction.",
      lines: [
        {
          key: "ui",
          name: "UI",
          stations: ["ui-panel"],
          shared: { projectFacts: ["vite.config.ts runs Vitest in node"] },
        },
        { key: "data", name: "Data", stations: ["data-model"] },
        {
          key: "release",
          name: "Release",
          unloadRecommendation: {
            mode: "human_approval",
            reason: "Visible change.",
          },
          stations: [],
        },
      ],
      junctions: [
        {
          key: "profile",
          name: "Customer profile",
          brief: {
            goal: "Show the customer profile",
            scope: ["Profile panel and its data"],
            contracts: [],
            invariants: ["Other panels are unchanged"],
            acceptanceCriteria: ["The panel shows the profile"],
            validation: [{ name: "test", command: ["npm", "test"] }],
          },
          incoming: ["ui", "data"],
          outgoing: "release",
        },
      ],
    }
    const { replies } = run([
      setOutline(junctionOutline),
      put(station("ui-panel")),
      put(station("data-model")),
      finalize,
    ])
    const accepted = replies.at(-1)!
    expect(accepted.outcome).toBe("accepted")
    const proposal = accepted.proposal!
    expect(proposal.lines).toEqual([])
    expect(proposal.junctions).toHaveLength(1)
    const [junction] = proposal.junctions!
    expect(junction!.incoming.map((l) => l.name)).toEqual(["UI", "Data"])
    expect(junction!.incoming[0]).not.toHaveProperty("key")
    expect(junction!.incoming[0]!.stations[0]!.manifest.projectFacts).toEqual([
      "vite.config.ts runs Vitest in node",
    ])
    expect(junction!.outgoing).toEqual({
      name: "Release",
      unloadMode: "human_approval",
      stations: [],
    })
  })

  it("moves the baseline fix Line out of the top-level Lines", () => {
    const failing: BaselineReport = {
      commit: "a".repeat(40),
      checks: [
        {
          name: "test",
          status: "failed",
          exitCode: 1,
          outputTail: "1 failing",
          outputTruncated: false,
        },
      ],
    }
    const withFix = {
      ...outline,
      lines: [
        ...outline.lines,
        {
          key: "fix",
          name: "Baseline fix",
          unloadRecommendation: auto,
          stations: ["fix-tests"],
        },
      ],
      baselineFix: { reason: "The test check fails.", line: "fix" },
    }
    const failingContext = { ...context, baseline: failing }
    const { replies } = run(
      [...complete, setOutline(withFix), put(station("fix-tests")), finalize],
      emptyPlanDraft,
      failingContext
    )
    const proposal = replies.at(-1)!.proposal!
    expect(proposal.lines.map((l) => l.key)).toEqual(["alpha", "beta"])
    expect(proposal.baselineFix).toMatchObject({
      reason: "The test check fails.",
      line: { key: "fix", stations: [{ key: "fix-tests" }] },
    })

    // Without a failing baseline, the outline itself is refused.
    const refused = run([setOutline(withFix)]).replies[0]!
    expect(refused.outcome).toBe("rejected")
    expect(refused.text).toContain("the baseline checks did not fail")
  })
})

describe("put_station", () => {
  it("rejects a Station that fails the schema and leaves the draft unchanged", () => {
    const { replies, draft } = run([
      setOutline(outline),
      put(station("a1", { expectedAreas: ["src/a1.ts (add the panel)"] })),
    ])
    const reply = replies[1]!
    expect(reply.outcome).toBe("rejected")
    expect(reply.text).toContain("Not saved: Station `a1`")
    expect(reply.text).toContain(
      "expectedAreas.0: Use a repository-relative file or directory"
    )
    expect(draft.stations).toEqual({})
    expect(reply.text).toContain("Saved 0 of 3 Stations")
  })

  it("saves a Station with plan problems and names them", () => {
    const { replies, draft } = run([
      setOutline(outline),
      put(station("a1", { expectedEvidence: ["lint"], dependencies: ["a2"] })),
    ])
    const reply = replies[1]!
    expect(reply.outcome).toBe("saved")
    expect(Object.keys(draft.stations)).toEqual(["a1"])
    expect(reply.text).toContain(
      "evidence lint is not a configured project check"
    )
    expect(reply.text).toContain(
      "dependency a2 must be an earlier Station on the same Line"
    )
    expect(reply.text).toContain("Still to save: `a2`, `b1`")
  })

  it("asks for an invariant when neither the Station nor its Line has one", () => {
    const reply = run([
      setOutline(outline),
      put(station("b1", { invariants: [] })),
    ]).replies[1]!
    expect(reply.outcome).toBe("saved")
    expect(reply.text).toContain(
      "`invariants` is empty, and the Line's `shared.invariants` has none either"
    )
  })

  it("does not report problems of Stations that are not saved yet", () => {
    const reply = run([setOutline(outline), put(station("b1"))]).replies[1]!
    expect(reply.text).not.toContain("Problems")
    expect(reply.text).toContain("Saved 1 of 3 Stations")
  })

  it("notes a Station that is not on any Line, and one saved before the outline", () => {
    const { replies } = run([put(station("orphan")), setOutline(outline)])
    expect(replies[0]!.outcome).toBe("saved")
    expect(replies[0]!.text).toContain("No outline is saved yet")
    expect(replies[1]!.text).toContain(
      "Saved Stations not in this outline, ignored unless you add them back: `orphan`"
    )
    const again = run([put(station("orphan"))], replies[1]!.draft).replies[0]!
    expect(again.text).toContain("It is not on any Line in the outline")
  })

  it("replaces an earlier version of the same Station", () => {
    const { replies, draft } = run([
      put(station("a1")),
      put(station("a1", { goal: "Deliver a1 differently" })),
    ])
    expect(replies[1]!.text).toContain("replacing the earlier version")
    expect(draft.stations.a1!.goal).toBe("Deliver a1 differently")
  })

  it("accepts lists sent as text, null values, and a wrapped Station", () => {
    const { replies, draft } = run([
      put({
        station: {
          ...station("a1"),
          scope: "- Only the a1 behavior\n- Nothing else",
          expectedAreas: '["src/a1.ts"]',
          avoidAreas: null,
          contracts: '[{"name":"a1 API","kind":"api","change":"adds"}]',
        },
      }),
    ])
    expect(replies[0]!.outcome).toBe("saved")
    expect(draft.stations.a1).toMatchObject({
      scope: ["Only the a1 behavior", "Nothing else"],
      expectedAreas: ["src/a1.ts"],
      contracts: [{ name: "a1 API", kind: "api", change: "adds" }],
    })
    expect(draft.stations.a1).not.toHaveProperty("avoidAreas")
  })

  it("never treats an inherited property as a saved Station", () => {
    const { replies } = run([
      setOutline({
        ...outline,
        lines: [{ ...outline.lines[1]!, stations: ["constructor"] }],
      }),
      finalize,
    ])
    expect(replies[0]!.text).toContain("Still to save: `constructor`")
    expect(replies[1]!.outcome).toBe("rejected")
  })
})

describe("set_plan_outline", () => {
  it("accepts the outline as JSON text and reports a precise parse failure", () => {
    const saved = run([setOutline(JSON.stringify(outline))]).replies[0]!
    expect(saved.outcome).toBe("saved")
    expect(saved.text).toContain("Saved the outline: 2 Lines and 3 Stations")

    const broken = run([setOutline("I will write the outline next.")])
      .replies[0]!
    expect(broken.outcome).toBe("rejected")
    expect(broken.text).toContain("Not saved: the outline is not valid JSON.")
    expect(broken.text).toContain("The JSON is not valid.")
    expect(broken.draft).toBe(emptyPlanDraft)
  })

  it("refuses an outline that does not match the schema", () => {
    const reply = run([
      setOutline({
        ...outline,
        lines: [{ ...outline.lines[0], key: "Alpha" }],
      }),
    ]).replies[0]!
    expect(reply.outcome).toBe("rejected")
    expect(reply.text).toContain("lines.0.key")
  })

  it("refuses structural problems and keeps the earlier outline", () => {
    const first = run([setOutline(outline)]).draft
    const reply = run(
      [
        setOutline({
          ...outline,
          lines: [
            outline.lines[0],
            { ...outline.lines[1], stations: ["b1", "a1"] },
          ],
          junctions: [
            {
              key: "feature",
              name: "Feature",
              brief: {
                goal: "A feature",
                scope: ["Feature"],
                contracts: [],
                invariants: [],
                acceptanceCriteria: ["Done"],
                validation: [{ name: "test", command: ["npm", "test"] }],
              },
              incoming: ["alpha", "gamma"],
              outgoing: "alpha",
            },
          ],
        }),
      ],
      first
    ).replies[0]!
    expect(reply.outcome).toBe("rejected")
    expect(reply.draft).toBe(first)
    expect(reply.text).toContain(
      "Station `a1` is listed on Line `alpha` and Line `beta`"
    )
    expect(reply.text).toContain(
      "Junction `feature` names Line `gamma`, which is not in `lines`"
    )
    expect(reply.text).toContain(
      "Line `alpha` is placed twice: incoming to Junction `feature` and outgoing from Junction `feature`"
    )
  })

  it("enforces the plan size limits", () => {
    const lines = Array.from({ length: 9 }, (_, i) => ({
      key: `line-${i}`,
      name: `Line ${i}`,
      unloadRecommendation: auto,
      stations: Array.from(
        { length: i === 0 ? 7 : 3 },
        (_, j) => `s-${i}-${j}`
      ),
    }))
    const reply = run([setOutline({ summary: "Too big.", lines })]).replies[0]!
    expect(reply.outcome).toBe("rejected")
    expect(reply.text).toContain("The plan has 31 Stations; the most is 24")
    expect(reply.text).toContain("9 top-level Lines; the most is 8")
    expect(reply.text).toContain(
      "Line `line-0` has 7 Stations; a top-level Line has at most 6"
    )
  })

  it("accepts a plan at every size limit, as the proposal schema does", () => {
    // Every Line, one of them full, holding every Station the plan allows.
    const sizes: number[] = [planLimits.stationsPerLine]
    let left = planLimits.stations - planLimits.stationsPerLine
    for (let lines = planLimits.lines - 1; lines > 0; lines--) {
      sizes.push(Math.ceil(left / lines))
      left -= sizes.at(-1)!
    }
    const lines = sizes.map((size, l) => ({
      key: `line-${l}`,
      name: `Line ${l}`,
      unloadRecommendation: auto,
      stations: Array.from({ length: size }, (_, s) => `s-${l}-${s}`),
    }))
    const { replies } = run([
      setOutline({ summary: "As large as allowed.", lines }),
      ...lines.flatMap((line) => line.stations.map((key) => put(station(key)))),
      finalize,
    ])
    expect(replies[0]!.outcome).toBe("saved")
    expect(replies.at(-1)!.outcome).toBe("accepted")
  })

  it("checks routes with the domain's launch rules", () => {
    const reply = run([
      setOutline({
        ...outline,
        lines: [
          {
            ...outline.lines[0],
            route: [{ kind: "station", key: "a1" }],
          },
          outline.lines[1],
        ],
      }),
    ]).replies[0]!
    expect(reply.outcome).toBe("rejected")
    expect(reply.text).toContain(
      "Route must include every owned Station exactly once"
    )
  })

  it("rechecks saved Stations against a new outline", () => {
    const { draft } = run(complete)
    const reply = run(
      [
        setOutline({
          ...outline,
          lines: [{ ...outline.lines[0], shared: undefined }, outline.lines[1]],
        }),
      ],
      draft
    ).replies[0]!
    expect(reply.outcome).toBe("saved")
    expect(reply.text).toContain("Problems in the plan so far:")
    expect(reply.text).toContain(
      "Station `a2`: `invariants` is empty, and the Line's `shared.invariants` has none either"
    )
  })
})

describe("inspect_plan", () => {
  it("lists Lines, unsaved Stations, problems and the outline", () => {
    const { draft } = run([
      setOutline(outline),
      put(station("a1", { expectedEvidence: ["lint"] })),
    ])
    const reply = planToolReply(planToolNames.inspect, {}, draft, context)
    expect(reply.outcome).toBe("read")
    expect(reply.draft).toBe(draft)
    expect(reply.text).toContain(
      "- `alpha` Alpha (top-level): a1, a2 (not saved)"
    )
    expect(reply.text).toContain(
      "Station `a1`: Alpha / Station a1: evidence lint is not a configured project check."
    )
    expect(reply.text).toContain(JSON.stringify(draft.outline))
  })

  it("reads back one saved Station", () => {
    const { draft } = run([put(station("a1"))])
    const reply = planToolReply(
      planToolNames.inspect,
      { station: "a1" },
      draft,
      context
    )
    expect(reply.text).toContain(JSON.stringify(draft.stations.a1))
    expect(
      planToolReply(planToolNames.inspect, { station: "zz" }, draft, context)
        .text
    ).toContain("Station `zz` is not saved.")
  })
})

describe("finalize_plan", () => {
  it("refuses without an outline or with unsaved Stations", () => {
    expect(run([finalize]).replies[0]!.text).toContain(
      "No outline is saved yet"
    )
    const reply = run([
      setOutline(outline),
      put(station("a1", { expectedEvidence: ["lint"] })),
      finalize,
    ]).replies[2]!
    expect(reply.outcome).toBe("rejected")
    expect(reply.text).toContain(
      "These Stations are in the outline but not saved: `a2`, `b1`"
    )
    // Known problems come in the same reply, so one round fixes everything.
    expect(reply.text).toContain(
      "- Station `a1`: Alpha / Station a1: evidence lint is not a configured project check."
    )
  })

  it("names the Stations where problems remain after an unrelated save", () => {
    const reply = run([
      setOutline(outline),
      put(station("b1", { expectedEvidence: ["lint"] })),
      put(station("a1")),
    ]).replies[2]!
    expect(reply.text).toContain(
      "Problems remain in Station `b1`; `terminus_inspect_plan` lists them."
    )
  })

  it("names the Station each launch problem concerns", () => {
    const reply = run([
      ...complete,
      put(station("b1", { expectedEvidence: ["lint"] })),
      finalize,
    ]).replies.at(-1)!
    expect(reply.outcome).toBe("rejected")
    expect(reply.text).toContain("Terminus assessment found problems")
    expect(reply.text).toContain(
      "- Station `b1`: Beta / Station b1: evidence lint is not a configured project check."
    )
  })

  it("names the Station a proposal schema problem concerns", () => {
    const reply = run([
      ...complete,
      put(station("b1", { expectedEvidence: [] })),
      finalize,
    ]).replies.at(-1)!
    expect(reply.outcome).toBe("rejected")
    expect(reply.text).toContain("The plan is not complete:")
    expect(reply.text).toContain("- Station `b1`: manifest.expectedEvidence:")
  })

  it("reports problems between Lines", () => {
    const reply = run([
      ...complete,
      put(
        station("a2", {
          invariants: [],
          expectedEvidence: [],
          contracts: [{ name: "profile API", kind: "api", change: "adds" }],
        })
      ),
      put(
        station("b1", {
          contracts: [
            { name: "profile API", kind: "api", change: "depends_on" },
          ],
        })
      ),
      finalize,
    ]).replies.at(-1)!
    expect(reply.outcome).toBe("rejected")
    expect(reply.text).toContain(
      "- Alpha and Beta share a code dependency on profile API"
    )
  })
})

describe("plan tools", () => {
  it("lists four tools, with flat Station arguments", () => {
    const tools = planTools(false)
    expect(tools.map((t) => t.name)).toEqual([
      "set_plan_outline",
      "put_station",
      "inspect_plan",
      "finalize_plan",
    ])
    const stationSchema = tools[1]!.inputSchema as {
      properties: Record<string, { anyOf?: { type?: string }[] }>
      required: string[]
    }
    expect(stationSchema.properties.changeKind).toBeDefined()
    expect(stationSchema.properties.scope!.anyOf?.map((s) => s.type)).toEqual([
      "array",
      "string",
    ])
    expect(planTools(true)[1]).toEqual(planTools(false)[1])
    expect(stationSchema.required).toEqual(
      expect.arrayContaining(["key", "name", "goal", "scope"])
    )
    expect(stationSchema.required).not.toContain("invariants")
    // Lookahead patterns are dropped; simple ones stay.
    const text = JSON.stringify(tools)
    expect(text).not.toContain("(?")
    expect(text).not.toContain("$schema")
    expect(text).toContain("^[a-z][a-z0-9-]{0,39}$")
  })

  it("takes the outline as text or as an object", () => {
    const outlineArg = (asText: boolean) =>
      (
        planTools(asText)[0]!.inputSchema as {
          properties: { outline: { type: string } }
        }
      ).properties.outline.type
    expect(outlineArg(true)).toBe("string")
    expect(outlineArg(false)).toBe("object")
  })

  it.each([false, true])(
    "accepts arrays and text through the same Station schema (outline as text: %s)",
    (asText) => {
      const schema = z.fromJSONSchema(
        planTools(asText)[1]!.inputSchema as Parameters<
          typeof z.fromJSONSchema
        >[0]
      )
      const args = {
        ...station("a1"),
        scope: "Selection covers the current page.\nKeep sorting unchanged.",
        expectedAreas: "src/a1.ts\nsrc/a1.test.ts",
        avoidAreas: "",
        contracts: '[{"name":"a1 API","kind":"api","change":"adds"}]',
        invariants: "",
        dependencies: "",
        acceptanceCriteria: 'Show "N selected".\nSelect all visible rows.',
        expectedEvidence: "",
        projectFacts: "Tests use the node environment (vite.config.ts).",
      }
      expect(schema.parse(args)).toEqual(args)
      const arrayArgs = {
        ...station("a2"),
        contracts: [{ name: "a2 API", kind: "api", change: "adds" }],
      }
      expect(schema.parse(arrayArgs)).toEqual(arrayArgs)
      const mixedArgs = { ...station("b1"), scope: "Only the b1 behavior" }
      expect(schema.parse(mixedArgs)).toEqual(mixedArgs)
      const { replies, draft } = run([
        setOutline(outline),
        put(args),
        put(arrayArgs),
        put(mixedArgs),
        finalize,
      ])
      expect(replies[1]!.outcome).toBe("saved")
      expect(replies.at(-1)!.outcome).toBe("accepted")
      expect(draft.stations.a1).toMatchObject({
        scope: [
          "Selection covers the current page.",
          "Keep sorting unchanged.",
        ],
        expectedAreas: ["src/a1.ts", "src/a1.test.ts"],
        avoidAreas: [],
        contracts: [{ name: "a1 API", kind: "api", change: "adds" }],
        invariants: [],
        dependencies: [],
        acceptanceCriteria: ['Show "N selected".', "Select all visible rows."],
        expectedEvidence: [],
        projectFacts: ["Tests use the node environment (vite.config.ts)."],
      })
      expect(
        replies.at(-1)!.proposal!.lines[0]!.stations[0]!.manifest
      ).toMatchObject({
        invariants: ["Everything stays client-side"],
        expectedEvidence: ["test"],
      })

      // Transport strings cannot bypass the full server-side schema or assessment.
      const invalid = planToolReply(
        planToolNames.station,
        { ...args, expectedAreas: "../outside.ts" },
        draft,
        context
      )
      expect(invalid.outcome).toBe("rejected")
      expect(invalid.draft).toBe(draft)
      const unknownCheck = planToolReply(
        planToolNames.station,
        { ...args, expectedEvidence: "unconfigured-check" },
        draft,
        context
      )
      expect(reviewPlanDraft(unknownCheck.draft, context).kind).toBe(
        "assessment"
      )
      for (const invalidFields of [
        { scope: "" },
        { scope: '["broken JSON"' },
        { scope: [42] },
        { contracts: "an API contract" },
      ]) {
        expect(
          planToolReply(
            planToolNames.station,
            { ...args, ...invalidFields },
            draft,
            context
          ).outcome
        ).toBe("rejected")
      }
    }
  )
})
