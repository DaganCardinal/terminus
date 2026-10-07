import type { GitWorkspace } from "@terminus/artifacts"
import type { CheckResult } from "@terminus/domain"
import { commandResultSchema, type ValidationCommand } from "@terminus/protocol"

/**
 * Installs dependencies, then runs every configured check. A check passes only
 * with exit code zero and complete output; a failed install skips the rest.
 */
export async function runProjectChecks(
  workspace: GitWorkspace,
  validation: ValidationCommand[],
  cwd = "/workspace/repo"
): Promise<CheckResult[]> {
  const checks: CheckResult[] = []
  const run = async (name: string, command: string[]) => {
    const result = commandResultSchema.parse(await workspace.run(command, cwd))
    const passed = result.exitCode === 0 && !result.outputTruncated
    checks.push({
      name,
      command,
      required: true,
      status: passed ? "passed" : "failed",
      ...result,
    })
    return passed
  }
  const installed = await run("npm ci", ["npm", "ci"])
  for (const check of validation) {
    if (installed) await run(check.name, check.command)
    else
      checks.push({
        name: check.name,
        command: check.command,
        required: true,
        status: "skipped",
      })
  }
  return checks
}
