import { z } from "zod"

export interface DispatchValidationIssue {
  path: string
  code: string
}

/** Safe field locations and codes only; never put model output or Zod messages in diagnostics. */
export class DispatchProposalError extends Error {
  readonly issues: readonly DispatchValidationIssue[]
  constructor(issues: readonly DispatchValidationIssue[]) {
    super(
      `Dispatcher proposal failed validation after three attempts: ${issues.map((issue) => `${issue.path} (${issue.code})`).join("; ")}`
    )
    this.name = "DispatchProposalError"
    this.issues = issues
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
