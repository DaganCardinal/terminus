import type { EngineerContext } from "@terminus/protocol"

/** Diagnostics remain data and are bounded before being sent to a decision model. */
export function engineerText(text: string): string {
  return text
    .replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "")
    .replace(/(bearer\s+)[\w.-]+/gi, "$1[redacted]")
    .replace(/\bsk-(?:proj-)?[\w-]+/g, "[redacted]")
    .replace(
      /((?:authorization|api[_-]?key|access[_-]?token|password|secret|[a-z][a-z0-9_]*(?:token|key|password|secret)[a-z0-9_]*)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]"
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@")
}

export function boundEngineerContext(
  context: EngineerContext
): EngineerContext {
  let remaining = 12_000
  let truncated = context.truncated ?? false
  const text = (value: string, limit = 2_000) => {
    const cleaned = engineerText(value)
    const bounded = cleaned.slice(0, Math.min(limit, remaining))
    remaining -= bounded.length
    if (bounded.length < cleaned.length) truncated = true
    return bounded
  }
  const checks = (values: NonNullable<EngineerContext["checks"]>) =>
    values.slice(0, 32).map((check) => {
      const output = text(
        [check.stdout, check.stderr].filter(Boolean).join("\n")
      )
      return {
        name: text(check.name, 200),
        required: check.required,
        status: check.status,
        exitCode: check.exitCode,
        stdout: output,
        outputTruncated:
          check.outputTruncated ||
          output.length <
            [check.stdout, check.stderr].filter(Boolean).join("\n").length,
      }
    })
  // Current validation gets priority over older diagnostics.
  if (
    (context.checks?.length ?? 0) > 32 ||
    context.history.some(
      (entry) =>
        (entry.checks?.length ?? 0) > 32 ||
        (entry.issues?.length ?? 0) > 16 ||
        (entry.feedback?.findings.length ?? 0) > 16
    )
  )
    truncated = true
  const current = context.checks ? checks(context.checks) : undefined
  const history = context.history.slice(-4).map((entry) => ({
    ...entry,
    issues: entry.issues
      ?.slice(0, 16)
      .map((issue) => ({ ...issue, detail: text(issue.detail) })),
    feedback: entry.feedback
      ? {
          summary: text(entry.feedback.summary),
          findings: entry.feedback.findings
            .slice(0, 16)
            .map((finding) => text(finding)),
        }
      : undefined,
    checks: entry.checks ? checks(entry.checks) : undefined,
  }))
  return {
    history,
    checks: current,
    truncated: truncated || context.history.length > 4,
  }
}
