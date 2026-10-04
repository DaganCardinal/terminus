export type IssueKind =
  | "required_checks_failed"
  | "conflict"
  | "dependency_unresolvable"
  | "station_failed"
  | "station_change_required"
  | "station_retries_exhausted"
  | "review_escalated"
  | "integration_failed"
  | "needs_user"

/** A problem that needs intervention. Raising one blocks the Train. */
export interface Issue {
  kind: IssueKind
  detail: string
}
