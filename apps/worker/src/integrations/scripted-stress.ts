import {
  proposalSchema,
  scriptedStressAgent,
  stressFiles,
  stressTask,
  workManifestSchema,
} from "@terminus/protocol"
import { z } from "zod"
import type { WorkManifest } from "@terminus/domain"
import {
  checkStressFiles,
  writeStressFiles,
  type GitWorkspace,
} from "@terminus/artifacts"

/** No client commands, repository instructions, or model calls are involved. */
export async function runStressStation(
  workspace: GitWorkspace,
  manifest: WorkManifest,
  directory: string
): Promise<string> {
  await writeStressFiles(
    workspace,
    stressFiles(stressTask(manifest)),
    directory
  )
  return "Versioned stress fixture wrote its checkpoint and contract test"
}

const reviewSchema = z.object({
  manifest: workManifestSchema,
  proposal: proposalSchema,
})

/** Evidence was collected in the normal sealed review checkout before this call. */
export async function reviewStressStation(
  workspace: GitWorkspace,
  material: Record<string, string>,
  directory: string
): Promise<string> {
  const input = reviewSchema.parse(
    JSON.parse(material["review.json"] ?? "null")
  )
  const files = stressFiles(stressTask(input.manifest))
  if (
    input.proposal.agent.harness !== scriptedStressAgent.harness ||
    input.proposal.agent.model !== scriptedStressAgent.model
  )
    throw new Error("Stress review requires scripted Station provenance")
  if (
    JSON.stringify([...input.proposal.changedPaths].sort()) !==
    JSON.stringify(Object.keys(files).sort())
  )
    throw new Error("Stress candidate changed paths outside its fixture")
  if (
    input.manifest.expectedEvidence.some(
      (name) =>
        !input.proposal.evidence.checks.some(
          (check) =>
            check.name === name && check.required && check.status === "passed"
        )
    )
  )
    throw new Error("Stress candidate lacks passing independent evidence")
  await checkStressFiles(workspace, files, directory)
  return JSON.stringify({
    verdict: "accept",
    summary:
      "Scripted fixture verified in the sealed candidate checkout; independent project checks passed",
    findings: [],
  })
}
