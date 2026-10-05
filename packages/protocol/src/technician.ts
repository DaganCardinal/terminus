import { z } from "zod"
import { featureBriefSchema } from "./junction"
import { validationCommandsSchema } from "./execution"
import {
  proposalSchema,
  conductorVerdictSchema,
  evidenceSchema,
} from "./agents"
import { workManifestSchema } from "./manifest"

const candidate = z.object({
  workspaceRepoId: z.string().min(1),
  proposal: proposalSchema,
  repairDiff: z.string(),
  repairPaths: z.array(z.string()),
})
const reviewed = candidate.extend({
  review: conductorVerdictSchema.extend({ model: z.string().min(1) }),
})
export const technicianRepairSchema = z.object({
  id: z.string().min(1),
  networkId: z.string().min(1),
  problem: z
    .object({ kind: z.enum(["conflict", "checks", "review"]), id: z.string() })
    .optional(),
  validation: validationCommandsSchema.optional(),
  featureBrief: featureBriefSchema.optional(),
  conflictId: z.string().min(1),
  source: z.object({
    junctionId: z.string().optional(),
    kind: z.enum(["junction_input", "junction_feature"]).optional(),
    integrationId: z.string().min(1),
    trainId: z.string().min(1),
    trainRepoId: z.string().min(1),
    trainCommit: z.string().min(1),
    trainBaseline: z.string().min(1),
    terminusRepoId: z.string().min(1),
    terminusCommit: z.string().min(1),
    acceptedCommits: z.array(z.string().min(1)),
  }),
  scope: z.array(z.string().min(1)).min(1),
  description: z.string(),
  manifests: z.array(workManifestSchema),
  expectedChecks: z.array(z.string().min(1)),
  agent: z.object({ harness: z.string(), model: z.string() }),
  createdAt: z.string(),
  integrationFailure: z
    .object({
      integrationId: z.string().min(1),
      detail: z.string(),
      evidence: evidenceSchema.optional(),
    })
    .optional(),
  state: z.discriminatedUnion("status", [
    z.object({ status: z.literal("requested") }),
    z.object({
      status: z.literal("running"),
      workspaceRepoId: z.string().min(1),
    }),
    candidate.extend({ status: z.literal("reviewing") }),
    reviewed.extend({
      status: z.enum(["ready", "rejected", "approved", "stale"]),
    }),
    reviewed.extend({
      status: z.literal("integrated"),
      integrationId: z.string().min(1),
    }),
    z.object({
      status: z.literal("failed"),
      detail: z.string(),
      workspaceRepoId: z.string().nullable(),
    }),
  ]),
})
export const repairCandidateSchema = candidate
