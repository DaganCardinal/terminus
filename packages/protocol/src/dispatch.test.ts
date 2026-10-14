import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  createDispatchPlanRequestSchema,
  dispatchProposalSchema,
  dispatchProposalSubmissionSchema,
  dispatchPlanSchema,
  planLimits,
} from "./dispatch"

const proposal = {
  summary: "A focused plan",
  lines: [
    {
      key: "red",
      name: "Red",
      unloadRecommendation: {
        mode: "auto",
        reason: "Bounded component change.",
      },
      stations: [
        {
          key: "footer",
          name: "Footer",
          manifest: {
            goal: "Add footer",
            repositoryChange: {
              kind: "implementation",
              description: "Add a footer component",
            },
            scope: ["Footer"],
            expectedAreas: ["src/footer.tsx"],
            avoidAreas: [],
            contracts: [],
            invariants: ["Existing behavior works"],
            dependencies: [],
            acceptanceCriteria: ["Footer is accessible"],
            expectedEvidence: ["test"],
          },
        },
      ],
    },
  ],
}

describe("planning boundaries", () => {
  it("requires concrete repository deliverables while preserving legacy plan inspection", () => {
    const p = JSON.parse(JSON.stringify(proposal)) as typeof proposal
    for (const repositoryChange of [
      undefined,
      { kind: "verification", description: "Run existing checks" },
      { kind: "tests", description: " " },
    ]) {
      const invalid = {
        ...p,
        lines: [
          {
            ...p.lines[0]!,
            stations: [
              {
                ...p.lines[0]!.stations[0]!,
                manifest: {
                  ...p.lines[0]!.stations[0]!.manifest,
                  repositoryChange,
                },
              },
            ],
          },
        ],
      }
      expect(dispatchProposalSchema.safeParse(invalid).success).toBe(false)
    }
    p.lines[0]!.stations[0]!.manifest.repositoryChange = {
      kind: "tests",
      description: "Add regression tests",
    }
    expect(dispatchProposalSchema.safeParse(p).success).toBe(true)
    const legacy = {
      ...p,
      lines: [
        {
          ...p.lines[0]!,
          unloadRecommendation: undefined,
          stations: [
            {
              ...p.lines[0]!.stations[0]!,
              manifest: {
                ...p.lines[0]!.stations[0]!.manifest,
                repositoryChange: undefined,
              },
            },
          ],
        },
      ],
    }
    expect(
      dispatchPlanSchema.safeParse({
        id: "plan",
        networkId: "network",
        goal: "Goal",
        terminusCommit: "base",
        model: "fake",
        createdAt: "now",
        state: {
          status: "ready",
          proposal: legacy,
          assessment: { errors: [], collisions: [] },
        },
      }).success
    ).toBe(true)
  })
  it("requires an idempotency identity and a bounded nonempty goal", () => {
    expect(
      createDispatchPlanRequestSchema.safeParse({
        requestId: "00000000-0000-4000-8000-000000000001",
        goal: "Build footer",
      }).success
    ).toBe(true)
    for (const goal of [" ", "a".repeat(4001)])
      expect(
        createDispatchPlanRequestSchema.safeParse({
          requestId: "00000000-0000-4000-8000-000000000001",
          goal,
        }).success
      ).toBe(false)
    expect(
      createDispatchPlanRequestSchema.safeParse({
        requestId: "anything",
        goal: "Build",
      }).success
    ).toBe(false)
  })
  it("rejects paths that cannot be reliably compared and untrusted execution configuration", () => {
    for (const area of [
      "../src",
      "/etc/passwd",
      "src/**",
      "src/../package.json",
      "src\\app.ts",
      "src//app.ts",
      ".",
      "src/button.tsx (consumes --primary via bg-primary/text-primary)",
      "all other colour tokens such as --accent, --ring, --chart-*",
    ]) {
      const p = JSON.parse(JSON.stringify(proposal)) as typeof proposal
      p.lines[0]!.stations[0]!.manifest.expectedAreas = [area]
      expect(dispatchProposalSchema.safeParse(p).success).toBe(false)
    }
    expect(
      dispatchProposalSchema.safeParse({
        ...proposal,
        validation: [{ command: ["rm", "-rf"] }],
      }).success
    ).toBe(false)
    expect(dispatchProposalSchema.parse(proposal)).toEqual(proposal)
  })
  it("supplies path constraints and prose guidance to the model's JSON schema", () => {
    const manifest =
      dispatchProposalSchema.shape.lines.element.shape.stations.element.shape
        .manifest
    for (const field of ["expectedAreas", "avoidAreas"] as const) {
      const area = z.toJSONSchema(manifest.shape[field].element)
      expect(area.description).toContain("No prose")
      const pattern = new RegExp(area.pattern!)
      for (const path of [
        "src/index.css",
        "src/components/",
        "My Folder/file.ts",
      ])
        expect(pattern.test(path)).toBe(true)
      for (const path of [
        "../src",
        "/etc/passwd",
        "src/**",
        "src/../app.ts",
        "src//app.ts",
        "src/button.tsx (note: consumes --primary)",
      ])
        expect(pattern.test(path)).toBe(false)
    }
  })
  it.each([
    { counts: [3, 3, 3, 3, 3, 3, 3, 3], valid: true },
    { counts: [6, 6, 6, 6], valid: true },
    { counts: [1, 1, 1, 1, 1, 1, 1, 1, 1], valid: false },
    { counts: [4, 3, 3, 3, 3, 3, 3, 3], valid: false },
    { counts: [7], valid: false },
    { counts: [], valid: false },
    { counts: [0], valid: false },
  ])(
    "validates proposal and stored plan sizes: $counts",
    ({ counts, valid }) => {
      const p = {
        ...proposal,
        lines: counts.map((count, i) => ({
          ...proposal.lines[0]!,
          key: `line-${i}`,
          stations: Array.from({ length: count }, (_, j) => ({
            ...proposal.lines[0]!.stations[0]!,
            key: `station-${i}-${j}`,
          })),
        })),
      }
      expect(dispatchProposalSchema.safeParse(p).success).toBe(valid)
      expect(
        dispatchPlanSchema.safeParse({
          id: "plan",
          networkId: "network",
          goal: "Goal",
          terminusCommit: "base",
          model: "fake",
          createdAt: "now",
          state: {
            status: "ready",
            proposal: p,
            assessment: { errors: [], collisions: [] },
          },
        }).success
      ).toBe(valid)
    }
  )
  it("rejects missing review criteria or evidence", () => {
    for (const field of [
      "scope",
      "expectedAreas",
      "invariants",
      "acceptanceCriteria",
      "expectedEvidence",
    ] as const) {
      const incomplete = JSON.parse(JSON.stringify(proposal)) as typeof proposal
      incomplete.lines[0]!.stations[0]!.manifest[field] = []
      expect(dispatchProposalSchema.safeParse(incomplete).success).toBe(false)
    }
  })
})

it("accepts and reads back a plan at every size limit, and refuses one past each", () => {
  const [line] = proposal.lines
  const plan = (sizes: number[]) => ({
    ...proposal,
    lines: sizes.map((size, l) => ({
      ...line!,
      key: `line-${l}`,
      name: `Line ${l}`,
      stations: Array.from({ length: size }, (_, s) => ({
        ...line!.stations[0]!,
        key: `s-${l}-${s}`,
      })),
    })),
  })
  // Every Line, one of them full, holding every Station the plan allows.
  const sizes: number[] = [planLimits.stationsPerLine]
  let left = planLimits.stations - planLimits.stationsPerLine
  for (let lines = planLimits.lines - 1; lines > 0; lines--) {
    sizes.push(Math.ceil(left / lines))
    left -= sizes.at(-1)!
  }
  const accepts = (sizes: number[]) =>
    dispatchProposalSchema.safeParse(plan(sizes)).success &&
    dispatchProposalSubmissionSchema.safeParse(plan(sizes)).success
  expect(accepts(sizes)).toBe(true)
  expect(
    dispatchPlanSchema.safeParse({
      id: "plan",
      networkId: "net",
      goal: "Goal",
      terminusCommit: "c",
      model: "m",
      createdAt: "now",
      state: {
        status: "ready",
        proposal: plan(sizes),
        assessment: { errors: [], collisions: [] },
      },
    }).success
  ).toBe(true)
  // One Station too many in the plan, or on one Line, or one Line too many.
  expect(accepts([...sizes.slice(0, -1), sizes.at(-1)! + 1])).toBe(false)
  expect(accepts([sizes[0]! + 1, sizes[1]! - 1, ...sizes.slice(2)])).toBe(false)
  expect(accepts(Array(planLimits.lines + 1).fill(1))).toBe(false)
})

it("accepts Junction-only proposals, counts all feature Stations, and retains legacy default Lines", () => {
  const station = proposal.lines[0]!.stations[0]!
  const feature = {
    key: "feature",
    name: "Feature",
    brief: {
      goal: "Assemble feature",
      scope: ["src/"],
      contracts: [],
      invariants: ["preserve existing behavior"],
      acceptanceCriteria: ["works together"],
      validation: [{ name: "test", command: ["npm", "test"] }],
    },
    incoming: [
      { name: "A", stations: [station] },
      { name: "B", stations: [{ ...station, key: "other" }] },
    ],
    outgoing: { name: "Deliver", stations: [] },
  }
  const p = { summary: "Feature", lines: [], junctions: [feature] }
  expect(dispatchProposalSchema.safeParse(p).success).toBe(true)
  expect(
    dispatchProposalSchema.safeParse({
      ...p,
      junctions: [{ ...feature, incoming: [feature.incoming[0]] }],
    }).success
  ).toBe(false)
  expect(
    dispatchProposalSchema.safeParse({
      ...p,
      junctions: Array.from({ length: 4 }, (_, i) => ({
        ...feature,
        key: `feature-${i}`,
        incoming: feature.incoming.map((l) => ({
          ...l,
          stations: Array.from({ length: 4 }, (_, n) => ({
            ...station,
            key: `station-${n}`,
          })),
        })),
      })),
    }).success
  ).toBe(false)
})

describe("exploration findings and baseline fixes", () => {
  const line = proposal.lines[0]!
  it("bounds findings to plain paths and short facts", () => {
    const finding = {
      topic: "Footer",
      summary: "The layout renders children in App.",
      paths: ["src/App.tsx"],
    }
    expect(
      dispatchProposalSchema.safeParse({ ...proposal, findings: [finding] })
        .success
    ).toBe(true)
    for (const findings of [
      [{ ...finding, paths: ["src/App.tsx (layout)"] }],
      [{ ...finding, summary: "x".repeat(601) }],
      Array.from({ length: 13 }, () => finding),
    ])
      expect(
        dispatchProposalSchema.safeParse({ ...proposal, findings }).success
      ).toBe(false)
  })
  it("allows a baseline fix of exactly one Station and counts it toward the limit", () => {
    const fix = {
      reason: "Tests fail on the baseline",
      line: {
        ...line,
        key: "fix",
        stations: [{ ...line.stations[0]!, key: "fix-tests" }],
      },
    }
    expect(
      dispatchProposalSchema.safeParse({ ...proposal, baselineFix: fix })
        .success
    ).toBe(true)
    for (const baselineFix of [
      {
        ...fix,
        line: {
          ...fix.line,
          stations: [...fix.line.stations, line.stations[0]!],
        },
      },
      {
        ...fix,
        line: { ...fix.line, route: [{ kind: "station", key: "fix-tests" }] },
      },
      { ...fix, selection: "reject" },
    ])
      expect(
        dispatchProposalSchema.safeParse({ ...proposal, baselineFix }).success
      ).toBe(false)
  })
  it("stores the baseline option, report and fix selection, and still reads older plans", () => {
    const base = {
      id: "plan",
      networkId: "net",
      goal: "Goal",
      terminusCommit: "c",
      model: "m",
      createdAt: "now",
    }
    const assessment = { errors: [], collisions: [] }
    expect(
      dispatchPlanSchema.safeParse({
        ...base,
        state: { status: "ready", proposal, assessment },
      }).success
    ).toBe(true)
    expect(
      dispatchPlanSchema.safeParse({
        ...base,
        checkBaseline: true,
        state: {
          status: "ready",
          proposal: {
            ...proposal,
            baselineFix: {
              reason: "Tests fail",
              selection: "reject",
              line: { ...line, key: "fix", unloadMode: "human_approval" },
            },
          },
          assessment,
          baseline: {
            commit: "c",
            checks: [
              {
                name: "test",
                status: "failed",
                exitCode: 1,
                outputTail: "1 failing",
                outputTruncated: false,
              },
            ],
          },
        },
      }).success
    ).toBe(true)
    expect(
      createDispatchPlanRequestSchema.safeParse({
        requestId: "64d6315b-7d66-4e50-94aa-4de0b71029ef",
        goal: "Goal",
        checkBaseline: true,
      }).success
    ).toBe(true)
  })
})
