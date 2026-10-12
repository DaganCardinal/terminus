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
    "Only a plain repository-relative file or directory, e.g. src/index.css or src/components/. No prose, parenthetical explanations, globs, CSS tokens, or lists of concepts. Put explanatory restrictions in scope or invariants instead; avoidAreas can be empty."
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

const plannedLineSchema = z
  .object({
    key,
    name: z.string().trim().min(1).max(120),
    unloadRecommendation: unloadRecommendationSchema,
    route: z.array(plannedStopSchema).min(1).max(24).optional(),
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
      .max(6),
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
      .max(4)
      .optional(),
    summary: text,
    lines: z.array(plannedLineSchema).min(0).max(8),
    findings: z.array(findingSchema).max(12).optional(),
    baselineFix: baselineFixSchema.optional(),
  })
  .strict()
  .refine(
    (proposal) =>
      proposal.lines.reduce((n, l) => n + l.stations.length, 0) +
        (proposal.baselineFix?.line.stations.length ?? 0) +
        (proposal.junctions ?? []).reduce(
          (n, j) =>
            n +
            j.incoming.reduce((m, l) => m + l.stations.length, 0) +
            j.outgoing.stations.length,
          0
        ) <=
        24 &&
      (proposal.lines.length > 0 || !!proposal.junctions?.length),
    "Plan at most twenty-four Stations"
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
            .max(6),
        })
      )
      .min(0)
      .max(8),
  })
  .strict()

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
const storedProposal = z
  .strictObject({
    ...dispatchProposalSchema.shape,
    lines: z
      .array(
        dispatchProposalSchema.shape.lines.element.extend({
          unloadRecommendation: unloadRecommendationSchema.optional(),
          unloadMode: unloadModeSchema.optional(),
          stations: z.array(storedStation).min(1).max(6),
        })
      )
      .min(0)
      .max(8),
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
      proposal.lines.reduce((n, line) => n + line.stations.length, 0) +
        (proposal.baselineFix?.line.stations.length ?? 0) +
        (proposal.junctions ?? []).reduce(
          (n, j) =>
            n +
            j.incoming.reduce((m, l) => m + l.stations.length, 0) +
            j.outgoing.stations.length,
          0
        ) <=
        24,
    "Plan at most twenty-four Stations"
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
    z.object({ status: z.literal("failed"), message: z.string() }),
  ]),
})
