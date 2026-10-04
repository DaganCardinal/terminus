import { z } from "zod"
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
    expectedEvidence: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  })
  .strict()

export const dispatchProposalSchema = z
  .object({
    summary: text,
    lines: z
      .array(
        z
          .object({
            key,
            name: z.string().trim().min(1).max(120),
            unloadRecommendation: unloadRecommendationSchema,
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
      )
      .min(1)
      .max(4),
  })
  .strict()
  .refine(
    (proposal) =>
      proposal.lines.reduce((n, l) => n + l.stations.length, 0) <= 12,
    "Plan at most twelve Stations"
  )

export const createDispatchPlanRequestSchema = z
  .object({
    requestId: z.uuid(),
    goal: z.string().trim().min(1).max(4000),
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
      .min(1)
      .max(4),
  })
  .refine(
    (proposal) =>
      proposal.lines.reduce((n, line) => n + line.stations.length, 0) <= 12,
    "Plan at most twelve Stations"
  )
const reviewed = { proposal: storedProposal, assessment }
export const dispatchPlanSchema = z.object({
  id: z.string(),
  networkId: z.string(),
  goal: z.string(),
  terminusCommit: z.string(),
  model: z.string(),
  createdAt: z.string(),
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

/** Ephemeral source context for a model; never persisted as project files in D1. */
export const repositoryContextSchema = z.object({
  commit: z.string(),
  paths: z.array(z.string()).max(500),
  pathsTruncated: z.boolean(),
  files: z
    .array(
      z.object({
        path: z.string(),
        content: z.string().max(4000),
        truncated: z.boolean(),
      })
    )
    .max(12),
})
export type RepositoryContext = z.infer<typeof repositoryContextSchema>
