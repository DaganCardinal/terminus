export type CheckStatus = "passed" | "failed" | "skipped"

/** One validation check run by orchestration code, never reported by an agent. */
export interface CheckResult {
  name: string
  required: boolean
  status: CheckStatus
  command?: string[]
  exitCode?: number
  stdout?: string
  stderr?: string
  outputTruncated?: boolean
}

/** Missing evidence is a failed gate, just like a skipped required check. */
export function unmetRequiredChecks(
  evidence: Evidence,
  expected: string[]
): CheckResult[] {
  return [
    ...failingRequiredChecks(evidence.checks),
    ...expected
      .filter(
        (name) =>
          !evidence.checks.some(
            (check) => check.name === name && check.status === "passed"
          )
      )
      .filter(
        (name) =>
          !evidence.checks.some(
            (check) =>
              check.name === name && check.required && check.status !== "passed"
          )
      )
      .map((name): CheckResult => ({
        name,
        required: true,
        status: "skipped",
      })),
  ]
}

export interface Evidence {
  checks: CheckResult[]
}

/** Required checks that did not pass. A skipped required check has not passed. */
export function failingRequiredChecks(checks: CheckResult[]): CheckResult[] {
  return checks.filter((check) => check.required && check.status !== "passed")
}
