import type { GitWorkspace } from "@terminus/artifacts"
import type { CheckResult } from "@terminus/domain"
import { commandResultSchema, type ValidationCommand } from "@terminus/protocol"
import { installCommand } from "./dependency-cache"

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
    const result = commandResultSchema.parse(
      workspace.install && command === installCommand
        ? await workspace.install(cwd)
        : await workspace.run(command, cwd)
    )
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
  const installed = await run("npm ci", installCommand)
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

/** Each stream keeps its tail, where failures are reported. */
const outputTail = 8000

/**
 * Runs every configured check in a checkout whose dependencies are already
 * installed. A check passes with exit code zero. `workspace` names the check
 * being run, for logs and failure reports.
 */
export async function runInstalledChecks(
  workspace: (check: string) => GitWorkspace,
  validation: ValidationCommand[],
  cwd: string
): Promise<CheckResult[]> {
  const checks: CheckResult[] = []
  for (const check of validation) {
    const result = commandResultSchema.parse(
      await workspace(check.name).run(check.command, cwd)
    )
    checks.push({
      name: check.name,
      command: check.command,
      required: true,
      status: result.exitCode === 0 ? "passed" : "failed",
      exitCode: result.exitCode,
      stdout: result.stdout.slice(-outputTail),
      stderr: result.stderr.slice(-outputTail),
      outputTruncated:
        !!result.outputTruncated ||
        result.stdout.length > outputTail ||
        result.stderr.length > outputTail,
    })
  }
  return checks
}
