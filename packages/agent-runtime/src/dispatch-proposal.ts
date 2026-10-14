import { z } from "zod"

export interface DispatchValidationIssue {
  path: string
  code: string
}

/** Safe field locations and codes only; never put model output or Zod messages in diagnostics. */
export class DispatchProposalError extends Error {
  readonly issues: readonly DispatchValidationIssue[]
  constructor(
    issues: readonly DispatchValidationIssue[],
    limit: "corrections" | "tool_rejections" = "corrections"
  ) {
    super(
      `Dispatcher proposal failed validation ${limit === "tool_rejections" ? "after repeated rejected plan tool calls" : "after three attempts"}: ${issues.map((issue) => `${issue.path} (${issue.code})`).join("; ")}`
    )
    this.name = "DispatchProposalError"
    this.issues = issues
  }
}

/**
 * The live runner stopped the harness after too many rejected plan tool calls
 * (\`maxRejectedPlanCalls\`, \`maxRejectedFinalizations\`). The saved draft is
 * final: no correction follows.
 */
export class ProposalSubmissionsExhausted extends Error {
  /** The harness's final message. */
  readonly submission: string
  constructor(submission: string) {
    super("Dispatcher stopped after repeated rejected proposal submissions")
    this.name = "ProposalSubmissionsExhausted"
    this.submission = submission
  }
}

/** The live runner paused a format-error loop; a bounded session correction may follow. */
export class PlanToolFormatStalled extends Error {
  constructor() {
    super(
      "Dispatcher plan tool arguments repeatedly failed to parse or match the schema"
    )
    this.name = "PlanToolFormatStalled"
  }
}

const fields = new Set([
  "junctions",
  "brief",
  "incoming",
  "outgoing",
  "validation",
  "command",
  "summary",
  "lines",
  "key",
  "name",
  "stations",
  "manifest",
  "goal",
  "scope",
  "expectedAreas",
  "avoidAreas",
  "contracts",
  "kind",
  "change",
  "invariants",
  "dependencies",
  "acceptanceCriteria",
  "expectedEvidence",
  "repositoryChange",
  "description",
  "route",
  "source",
  "stationKey",
  "stationId",
  "unloadRecommendation",
  "mode",
  "reason",
  "findings",
  "topic",
  "paths",
  "baselineFix",
  "line",
])

export function validationIssues(error: z.ZodError): DispatchValidationIssue[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.length
      ? issue.path
          .map((part) =>
            typeof part === "number"
              ? part
              : fields.has(String(part))
                ? String(part)
                : "[field]"
          )
          .join(".")
      : "$",
    code: issue.code,
  }))
}
