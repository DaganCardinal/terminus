import {
  commandResultSchema,
  proposalSchema,
  scriptedStressAgent,
  stressFiles,
  stressTask,
  workManifestSchema,
} from "@terminus/protocol"
import { z } from "zod"
import type { WorkManifest } from "@terminus/domain"
import type { GitWorkspace } from "@terminus/artifacts"

/** No client commands, repository instructions, or model calls are involved. */
export async function runStressStation(
  workspace: GitWorkspace,
  manifest: WorkManifest,
  directory: string
): Promise<string> {
  const files = stressFiles(stressTask(manifest))
  // Refuse existing paths and symlink parents, including those introduced by install scripts.
  const script = `const fs = require("node:fs"); const path = require("node:path");
    const files = JSON.parse(process.argv[1]);
    for (const [file, contents] of Object.entries(files)) {
      let current = process.cwd();
      for (const part of file.split("/").slice(0, -1)) {
        current = path.join(current, part);
        try { if (!fs.lstatSync(current).isDirectory()) throw new Error("Unsafe stress directory"); }
        catch (error) { if (error.code !== "ENOENT") throw error; fs.mkdirSync(current); }
      }
      fs.writeFileSync(file, contents, { flag: "wx" });
    }`
  const result = commandResultSchema.parse(
    await workspace.run(
      ["node", "-e", script, JSON.stringify(files)],
      directory
    )
  )
  if (result.exitCode !== 0) throw new Error("Scripted stress edit failed")
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
  const script = `const fs = require("node:fs"); const path = require("node:path");
    for (const [file, contents] of Object.entries(JSON.parse(process.argv[1]))) {
      let current = process.cwd();
      for (const part of file.split("/")) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Symlink in stress candidate");
      }
      if (fs.readFileSync(file, "utf8") !== contents) throw new Error("Incorrect stress checkpoint");
    }`
  const result = commandResultSchema.parse(
    await workspace.run(
      ["node", "-e", script, JSON.stringify(files)],
      directory
    )
  )
  if (result.exitCode !== 0)
    throw new Error("Stress candidate failed independent fixture verification")
  return JSON.stringify({
    verdict: "accept",
    summary:
      "Scripted fixture verified in the sealed candidate checkout; independent project checks passed",
    findings: [],
  })
}
