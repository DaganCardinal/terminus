import { z } from "zod"

export const repositoryChangeSchema = z
  .object({
    kind: z.enum([
      "implementation",
      "tests",
      "documentation",
      "configuration",
      "verification",
    ]),
    description: z.string().trim().min(1).max(2000),
  })
  .strict()
  .describe(
    "A concrete repository change. Running checks or confirming earlier work alone is not a change; adding or improving tests is."
  )

export const concreteRepositoryChangeSchema = repositoryChangeSchema.extend({
  kind: z.enum(["implementation", "tests", "documentation", "configuration"]),
})

export const contractSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["api", "schema", "symbol", "config", "other"]),
  change: z.enum(["adds", "changes", "depends_on"]),
})

export const workManifestSchema = z.object({
  goal: z.string().min(1),
  repositoryChange: repositoryChangeSchema.optional(),
  scope: z.array(z.string()),
  expectedAreas: z.array(z.string()),
  avoidAreas: z.array(z.string()),
  contracts: z.array(contractSchema),
  invariants: z.array(z.string()),
  dependencies: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  expectedEvidence: z.array(z.string()),
})
