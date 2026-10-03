import { z } from "zod"

export const contractSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["api", "schema", "symbol", "config", "other"]),
  change: z.enum(["adds", "changes", "depends_on"]),
})

export const workManifestSchema = z.object({
  goal: z.string().min(1),
  scope: z.array(z.string()),
  expectedAreas: z.array(z.string()),
  avoidAreas: z.array(z.string()),
  contracts: z.array(contractSchema),
  invariants: z.array(z.string()),
  dependencies: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  expectedEvidence: z.array(z.string()),
})
