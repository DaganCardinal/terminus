import { z } from "zod"
import type { WorkManifest } from "@terminus/domain"
import type { LayLineRequest, NetworkSnapshot } from "./api"

/** Explicit, versioned fixture; never an arbitrary script supplied by a client. */
export const PIPELINE_STRESS_PROFILE = "ten-trains-v1"
export const scriptedStressAgent = {
  harness: "scripted@ten-trains-v1",
  harnessVersion: "1",
  model: "scripted",
} as const
export const stressRunSchema = z.object({ runId: z.uuid() }).strict()
export const launchStressRequestSchema = z
  .object({
    requestId: z.uuid(),
    networkId: z.string().min(1).optional(),
  })
  .strict()
export const stressLaunchSchema = z.object({
  profile: z.literal(PIPELINE_STRESS_PROFILE),
  runId: z.uuid(),
  networkId: z.string(),
  baseline: z.string(),
  mode: z.enum(["artifacts", "fake"]),
})
export type StressLaunch = z.infer<typeof stressLaunchSchema>
export const stressVerifyRequestSchema = stressRunSchema.extend({
  baseline: z.string().regex(/^[a-f0-9]{40}$/),
})
export const stressTaskSchema = stressRunSchema.extend({
  train: z.number().int().min(1).max(10),
})
export type StressTask = z.infer<typeof stressTaskSchema>

export function stressFiles(task: StressTask): Record<string, string> {
  const { runId, train } = stressTaskSchema.parse(task)
  const name = `train-${String(train).padStart(2, "0")}`
  const base = `src/terminus-stress/${runId}/${name}`
  const value = `${runId}:${train}`
  return {
    [`${base}.ts`]: `export const checkpoint = ${JSON.stringify(value)}\n`,
    [`${base}.test.ts`]: [
      'import { expect, it } from "vitest"',
      `import { checkpoint } from "./${name}"`,
      `it("retains stress checkpoint ${train}", () => {`,
      `  expect(checkpoint).toBe(${JSON.stringify(value)})`,
      "})",
      "",
    ].join("\n"),
  }
}

export function stressManifest(task: StressTask): WorkManifest {
  const { runId, train } = stressTaskSchema.parse(task)
  const goal = `Pipeline stress ${PIPELINE_STRESS_PROFILE} ${runId} train ${train}`
  return {
    goal,
    repositoryChange: { kind: "implementation", description: goal },
    scope: ["Add an isolated checkpoint module and its Vitest contract test"],
    expectedAreas: Object.keys(stressFiles(task)),
    avoidAreas: ["package.json", "package-lock.json", "src/App.tsx"],
    contracts: [{ name: "checkpoint", kind: "symbol", change: "adds" }],
    invariants: [
      "Existing application behavior and project configuration stay intact",
    ],
    dependencies: [],
    acceptanceCriteria: [
      "Checkpoint equals the run identity and Train number",
      "All project checks pass",
    ],
    expectedEvidence: ["typecheck", "test", "build"],
  }
}

/** Compare all manifest fields; a matching goal alone must not execute a fixture. */
export function stressTask(manifest: WorkManifest): StressTask {
  const match = /^Pipeline stress ten-trains-v1 ([a-f0-9-]+) train (\d+)$/.exec(
    manifest.goal
  )
  if (!match)
    throw new Error(
      "Stress profile accepts only its versioned fixture manifests"
    )
  const task = stressTaskSchema.parse({
    runId: match[1],
    train: Number(match[2]),
  })
  const expected = stressManifest(task)
  const fields = Object.keys(expected) as (keyof WorkManifest)[]
  if (
    fields.some(
      (key) => JSON.stringify(manifest[key]) !== JSON.stringify(expected[key])
    ) ||
    Object.keys(manifest).some(
      (key) => !fields.includes(key as keyof WorkManifest)
    )
  )
    throw new Error("Stress manifest differs from the versioned fixture")
  return task
}

export function stressLines(runId: string): LayLineRequest[] {
  stressRunSchema.parse({ runId })
  return Array.from({ length: 10 }, (_, i) => ({
    name: `Stress ${runId} Train ${i + 1}`,
    unloadMode: "auto",
    stations: [
      {
        key: `checkpoint-${i + 1}`,
        name: `Checkpoint ${i + 1}`,
        manifest: stressManifest({ runId, train: i + 1 }),
      },
    ],
  }))
}

export const stressStatusSchema = z.object({
  profile: z.literal(PIPELINE_STRESS_PROFILE),
  leases: z.number().int().nonnegative(),
  expiredLeases: z.number().int().nonnegative(),
  activeIntegrations: z.number().int().nonnegative(),
  completedIntegrations: z.number().int().nonnegative(),
  failedIntegrations: z.number().int().nonnegative(),
})
export type StressStatus = z.infer<typeof stressStatusSchema>

/** Trains in these states no longer move without a user's intervention. */
const stoppedTrainStatuses = new Set(["unloaded", "blocked", "siding"])

/**
 * Why a report would not yet describe a final state, or null when it would.
 * Expired lease rows are excluded: they belong to Sandboxes that already
 * stopped, and capacity no longer counts them.
 */
export function stressReportPending(
  snapshot: Pick<NetworkSnapshot, "trains">,
  status: Pick<StressStatus, "leases" | "activeIntegrations">
): string | null {
  const moving = snapshot.trains.filter(
    ({ train }) => !stoppedTrainStatuses.has(train.state.status)
  ).length
  if (moving)
    return `${moving} Train${moving === 1 ? " is" : "s are"} still running`
  if (status.activeIntegrations)
    return "An integration into Terminus is still active"
  if (status.leases)
    return `${status.leases} Sandbox${status.leases === 1 ? " is" : "es are"} still running`
  return null
}

export const stressVerificationSchema = z.object({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.literal(20),
  reachableCars: z.literal(10),
  mergeCommits: z.array(z.string().regex(/^[a-f0-9]{40}$/)).length(10),
})

export const stressReportSchema = z
  .object({
    passed: z.boolean(),
    /** Every failed check, naming its Train; empty exactly when passed. */
    findings: z.array(z.string()),
    /** Observations that do not fail the run. */
    warnings: z.array(z.string()),
    mode: z.enum(["artifacts", "fake"]),
    run: stressLaunchSchema,
    verification: stressVerificationSchema.nullable(),
    status: stressStatusSchema,
    timings: z
      .object({
        maxQueueDepth: z.number(),
        drainMs: z.number().nullable(),
        integrationsPerMinute: z.number().nullable(),
        findings: z.array(z.string()),
      })
      .passthrough(),
  })
  .passthrough()
export type StressReport = z.infer<typeof stressReportSchema>
