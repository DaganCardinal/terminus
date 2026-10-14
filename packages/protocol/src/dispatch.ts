import { z } from "zod"
import { createJunctionRequestSchema } from "./junction"
import { plannedStopSchema } from "./crossing"
import {
  concreteRepositoryChangeSchema,
  repositoryChangeSchema,
  workManifestSchema,
} from "./manifest"

import { unloadRecommendationSchema, unloadModeSchema } from "./unload"

const text = z.string().trim().min(1).max(2000)
const key = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)
const area = z
  .string()
  .max(300)
  .regex(
    /^(?!\/)(?!.*[\\*?[\]{}:();])(?:(?!\.{1,2}(?:\/|$))[^/]+\/)*(?!\.{1,2}(?:\/|$))[^/]+\/?$/,
    "Use a repository-relative file or directory, without globs or traversal"
  )
  .refine(
    (path) =>
      path.length > 0 &&
      !path.startsWith("/") &&
      !["\\", "*", "?", "[", "]", "{", "}", ":", "(", ")", ";"].some(
        (character) => path.includes(character)
      ) &&
      ![...path].some((character) => character.charCodeAt(0) < 32) &&
      path
        .replace(/\/$/, "")
        .split("/")
        .every((part) => part.length > 0 && part !== "." && part !== ".."),
    "Use a repository-relative file or directory, without globs or traversal"
  )
  .describe(
    "Only a plain repository-relative file or directory, e.g. src/index.css or src/components/. No prose, parenthetical explanations, globs, CSS tokens, or lists of concepts. Put explanatory restrictions in scope or invariants instead; avoidAreas is usually empty."
  )
const evidenceNames = z.array(z.string().trim().min(1).max(100))
const manifest = workManifestSchema
  .extend({
    goal: text,
    repositoryChange: concreteRepositoryChangeSchema,
    scope: z.array(text).min(1).max(20),
    expectedAreas: z.array(area).min(1).max(20),
    avoidAreas: z.array(area).max(20),
    contracts: workManifestSchema.shape.contracts.max(20),
    invariants: z.array(text).min(1).max(20),
    dependencies: z.array(key).max(12),
    acceptanceCriteria: z.array(text).min(1).max(20),
    expectedEvidence: evidenceNames.min(1).max(20),
    projectFacts: z
      .array(text.max(400))
      .max(12)
      .optional()
      .describe(
        "Facts you verified about the project's tooling that this Station's implementer and reviewer would otherwise rediscover: the test runner and its environment (for example node or jsdom), setup files, how tests render or call the code, relevant libraries that are or are not installed. Each fact names the file that shows it. Observations only, never instructions."
      ),
  })
  .strict()

/**
 * The largest plan Terminus accepts. The proposal schemas, the plan tools'
 * outline checks and the Dispatcher's instructions all use these values.
 */
export const planLimits = {
  /** Top-level Lines. Junction and baseline-fix Lines do not count. */
  lines: 8,
  /** Stations on one top-level or baseline-fix Line. */
  stationsPerLine: 6,
  /** Stations in the whole plan, including Junction and baseline-fix Lines. */
  stations: 24,
  junctions: 4,
} as const

const plannedStationsLimit = `Plan at most ${planLimits.stations} Stations`

/** Every Station in a proposal, wherever its Line sits. */
function plannedStationCount(proposal: {
  lines: { stations: unknown[] }[]
  baselineFix?: { line: { stations: unknown[] } }
  junctions?: {
    incoming: { stations: unknown[] }[]
    outgoing: { stations: unknown[] }
  }[]
}): number {
  return (
    proposal.lines.reduce((n, line) => n + line.stations.length, 0) +
    (proposal.baselineFix?.line.stations.length ?? 0) +
    (proposal.junctions ?? []).reduce(
      (n, j) =>
        n +
        j.incoming.reduce((m, l) => m + l.stations.length, 0) +
        j.outgoing.stations.length,
      0
    )
  )
}

const plannedLineSchema = z
  .object({
    key,
    name: z.string().trim().min(1).max(120),
    unloadRecommendation: unloadRecommendationSchema,
    route: z
      .array(plannedStopSchema)
      .min(1)
      .max(planLimits.stations)
      .optional(),
    stations: z
      .array(
        z
          .object({
            key,
            name: z.string().trim().min(1).max(120),
            manifest,
          })
          .strict()
      )
      .min(1)
      .max(planLimits.stationsPerLine),
  })
  .strict()

/** What exploration established. Facts with cited paths, never file contents. */
const findingSchema = z
  .object({
    topic: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(600),
    paths: z.array(area).max(10),
  })
  .strict()

/** Only for failing baseline checks; Terminus routes every other Line through it. */
const baselineFixSchema = z
  .object({
    reason: z.string().trim().min(1).max(400),
    line: plannedLineSchema
      .omit({ route: true })
      .extend({ stations: plannedLineSchema.shape.stations.length(1) }),
  })
  .strict()

/**
 * Manifest values that hold for every Station on a Line. Terminus prepends
 * them to each Station's own values before validation, so a long Line states
 * them once instead of once per Station. Stored proposals never carry them.
 */
export const lineSharedSchema = z
  .object({
    avoidAreas: manifest.shape.avoidAreas.optional(),
    invariants: z.array(text).max(20).optional(),
    expectedEvidence: evidenceNames.max(20).optional(),
    projectFacts: manifest.shape.projectFacts,
  })
  .strict()
  .describe(
    "Optional. Values that apply to every Station on this Line. Terminus adds them to each Station's Manifest ahead of the Station's own values, so do not repeat them in the Stations. After merging, every Station still needs at least one invariant and one expectedEvidence name."
  )
export const lineSharedFields = [
  "avoidAreas",
  "invariants",
  "expectedEvidence",
  "projectFacts",
] as const

export const baselineFixSelectionSchema = z.enum(["include", "reject"])

export const selectBaselineFixRequestSchema = z
  .object({ selection: baselineFixSelectionSchema })
  .strict()
export type SelectBaselineFixRequest = z.infer<
  typeof selectBaselineFixRequestSchema
>

/** Trimmed results of trusted checks run on the planning baseline. */
export const baselineReportSchema = z.object({
  commit: z.string(),
  checks: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(["passed", "failed", "skipped"]),
        exitCode: z.number().int().optional(),
        outputTail: z.string().max(2000),
        outputTruncated: z.boolean(),
      })
    )
    .max(21),
})

export const dispatchProposalSchema = z
  .object({
    junctions: z
      .array(
        createJunctionRequestSchema.omit({ requestId: true }).extend({ key })
      )
      .max(planLimits.junctions)
      .optional(),
    summary: text,
    lines: z.array(plannedLineSchema).min(0).max(planLimits.lines),
    findings: z.array(findingSchema).max(12).optional(),
    baselineFix: baselineFixSchema.optional(),
  })
  .strict()
  .refine(
    (proposal) =>
      plannedStationCount(proposal) <= planLimits.stations &&
      (proposal.lines.length > 0 || !!proposal.junctions?.length),
    plannedStationsLimit
  )

/**
 * What the Dispatcher submits: the proposal, plus optional Line-shared
 * Manifest values. Terminus expands the shared values into each Station and
 * then validates the result against `dispatchProposalSchema`.
 */
export const dispatchProposalSubmissionSchema = z
  .object({
    ...dispatchProposalSchema.shape,
    lines: z
      .array(
        plannedLineSchema.extend({
          shared: lineSharedSchema.optional(),
          stations: z
            .array(
              plannedLineSchema.shape.stations.element.extend({
                manifest: manifest.extend({
                  invariants: z.array(text).max(20).optional(),
                  expectedEvidence: evidenceNames.max(20).optional(),
                }),
              })
            )
            .min(1)
            .max(planLimits.stationsPerLine),
        })
      )
      .min(0)
      .max(planLimits.lines),
  })
  .strict()

/**
 * One Line of a plan outline: its identity, route and ordered Station keys.
 * Each Station's Manifest arrives separately (`planStationSchema`).
 */
export const outlineLineSchema = z
  .object({
    key,
    name: plannedLineSchema.shape.name,
    unloadRecommendation: unloadRecommendationSchema
      .optional()
      .describe(
        "Required on top-level and baseline-fix Lines. On a Junction's outgoing Line, its mode sets how the finished feature unloads. Leave it out on Junction incoming Lines: they always unload into their Junction automatically."
      ),
    stations: z
      .array(key)
      .max(planLimits.stations)
      .describe(
        "This Line's Station keys, in order. Each Station needs its own put_station call. Only a Junction's outgoing Line may have none."
      ),
    route: plannedLineSchema.shape.route,
    shared: lineSharedSchema.optional(),
  })
  .strict()

/**
 * The network layout of a plan, without Station Manifests. Every Line is
 * listed once under `lines`; Junctions and the baseline fix name their Lines
 * by key. Terminus assembles the proposal from the outline and the Stations.
 */
export const planOutlineSchema = z
  .object({
    summary: text,
    lines: z.array(outlineLineSchema).min(1).max(32),
    junctions: z
      .array(
        z
          .object({
            key,
            name: createJunctionRequestSchema.shape.name,
            brief: createJunctionRequestSchema.shape.brief,
            incoming: z
              .array(key)
              .min(2)
              .max(8)
              .describe("Keys of the Lines that end at this Junction."),
            outgoing: key.describe(
              "Key of the Line that leaves this Junction for Terminus."
            ),
          })
          .strict()
      )
      .max(planLimits.junctions)
      .optional(),
    findings: z.array(findingSchema).max(12).optional(),
    baselineFix: z
      .object({
        reason: baselineFixSchema.shape.reason,
        line: key.describe(
          "Key of the Line, with exactly one Station and no route, that fixes the failing checks."
        ),
      })
      .strict()
      .optional(),
  })
  .strict()
export type PlanOutline = z.infer<typeof planOutlineSchema>

/**
 * One Station as the Dispatcher submits it: flat fields, so no value nests
 * deeper than a list. `invariants` and `expectedEvidence` may come from the
 * Line's `shared` values instead.
 */
export const planStationSchema = z
  .object({
    key,
    name: plannedLineSchema.shape.stations.element.shape.name,
    goal: manifest.shape.goal,
    changeKind: concreteRepositoryChangeSchema.shape.kind.describe(
      "The primary kind of repository change this Station delivers."
    ),
    changeDescription:
      concreteRepositoryChangeSchema.shape.description.describe(
        "The concrete repository change this Station delivers."
      ),
    scope: manifest.shape.scope,
    expectedAreas: manifest.shape.expectedAreas,
    avoidAreas: manifest.shape.avoidAreas.optional(),
    contracts: manifest.shape.contracts.optional(),
    invariants: lineSharedSchema.shape.invariants,
    dependencies: manifest.shape.dependencies.optional(),
    acceptanceCriteria: manifest.shape.acceptanceCriteria,
    expectedEvidence: lineSharedSchema.shape.expectedEvidence,
    projectFacts: manifest.shape.projectFacts,
  })
  .strict()
export type PlanStation = z.infer<typeof planStationSchema>

/** A plan being assembled from tool calls: the outline and Stations saved so far. */
export const planDraftSchema = z
  .object({
    outline: planOutlineSchema.optional(),
    stations: z.record(key, planStationSchema),
  })
  .strict()
export type PlanDraft = z.infer<typeof planDraftSchema>

export const createDispatchPlanRequestSchema = z
  .object({
    requestId: z.uuid(),
    goal: z.string().trim().min(1).max(4000),
    /** Install dependencies and run project checks before exploring. */
    checkBaseline: z.boolean().optional(),
  })
  .strict()
export type CreateDispatchPlanRequest = z.infer<
  typeof createDispatchPlanRequestSchema
>

const assessment = z.object({
  errors: z.array(z.string()),
  collisions: z.array(
    z.object({
      line: z.string(),
      otherLine: z.string(),
      paths: z.array(z.string()),
      contracts: z.array(z.string()),
    })
  ),
})
// Older persisted plans remain inspectable; assessment rejects their launch
// until they declare repository deliverables. New model output stays strict.
const storedStation =
  dispatchProposalSchema.shape.lines.element.shape.stations.element.extend({
    manifest: manifest.extend({
      repositoryChange: repositoryChangeSchema.optional(),
    }),
  })
// Reading follows `planLimits`, so a raised limit reads back. A lowered one
// must keep its old value here, or plans saved before it stop reading.
const storedProposal = z
  .strictObject({
    ...dispatchProposalSchema.shape,
    lines: z
      .array(
        dispatchProposalSchema.shape.lines.element.extend({
          unloadRecommendation: unloadRecommendationSchema.optional(),
          unloadMode: unloadModeSchema.optional(),
          stations: z
            .array(storedStation)
            .min(1)
            .max(planLimits.stationsPerLine),
        })
      )
      .min(0)
      .max(planLimits.lines),
    baselineFix: baselineFixSchema
      .extend({
        line: baselineFixSchema.shape.line.extend({
          unloadMode: unloadModeSchema.optional(),
        }),
        selection: baselineFixSelectionSchema.optional(),
      })
      .optional(),
  })
  .refine(
    (proposal) =>
      (proposal.lines.length > 0 || !!proposal.junctions?.length) &&
      plannedStationCount(proposal) <= planLimits.stations,
    plannedStationsLimit
  )
const reviewed = {
  proposal: storedProposal,
  assessment,
  baseline: baselineReportSchema.optional(),
}
export const dispatchPlanSchema = z.object({
  id: z.string(),
  networkId: z.string(),
  goal: z.string(),
  terminusCommit: z.string(),
  model: z.string(),
  agent: z
    .object({
      harness: z.string(),
      model: z.string(),
      provider: z.string().optional(),
      harnessVersion: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
  checkBaseline: z.boolean().optional(),
  state: z.discriminatedUnion("status", [
    z.object({ status: z.literal("planning") }),
    z.object({ status: z.literal("ready"), ...reviewed }),
    z.object({ status: z.literal("launching"), ...reviewed }),
    z.object({
      status: z.literal("starting"),
      ...reviewed,
      lineIds: z.array(z.string()),
      trainIds: z.array(z.string()),
    }),
    z.object({
      status: z.literal("launched"),
      ...reviewed,
      lineIds: z.array(z.string()),
      trainIds: z.array(z.string()),
    }),
    z.object({
      status: z.literal("failed"),
      message: z.string(),
      reason: z.literal("cancelled").optional(),
      cleanupPending: z.boolean().optional(),
    }),
  ]),
})
