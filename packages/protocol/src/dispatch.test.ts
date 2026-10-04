import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  createDispatchPlanRequestSchema,
  dispatchProposalSchema,
  dispatchPlanSchema,
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
