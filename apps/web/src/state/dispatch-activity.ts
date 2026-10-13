import type {
  AgentActivity,
  AgentActivityEntry,
  AgentPhase,
} from "@terminus/protocol"

const phases: Record<AgentPhase, string> = {
  preparing_workspace: "Preparing the planning workspace",
  waiting_for_sandbox: "Waiting for the Sandbox to be ready",
  checking_out: "Checking out the project baseline",
  checking_baseline: "Installing dependencies and running baseline checks",
  sealing_workspace: "Preparing read-only exploration",
  starting_agent: "Starting the Dispatcher",
  exploring: "Exploring the project and drafting the plan",
  validating_proposal: "Validating the proposal",
  correcting_proposal: "Correcting the proposal",
  closing_workspace: "Closing the planning workspace",
  saving_proposal: "Saving the proposal",
  simulation: "Preparing an offline simulated plan",
}

export function activityLabel(activity: AgentActivity): string {
  if (activity.kind === "phase") return phases[activity.phase]
  const labels = {
    read: ["File read started", "Read a file", "File read failed"],
    search: [
      "Project search started",
      "Searched the project",
      "Project search failed",
    ],
    list: [
      "File listing started",
      "Listed project files",
      "File listing failed",
    ],
    explore: [
      "Focused exploration started",
      "Completed focused exploration",
      "Focused exploration failed",
    ],
    command: ["Command started", "Ran a command", "Command failed"],
  }
  return labels[activity.tool][
    activity.status === "running" ? 0 : activity.status === "completed" ? 1 : 2
  ]!
}

type Stage =
  | "preparation"
  | "exploration"
  | "proposal"
  | "finishing"
  | "simulation"
  | "agent"
const stages: Record<AgentPhase, Stage> = {
  preparing_workspace: "preparation",
  waiting_for_sandbox: "preparation",
  checking_out: "preparation",
  checking_baseline: "preparation",
  sealing_workspace: "preparation",
  starting_agent: "preparation",
  exploring: "exploration",
  validating_proposal: "proposal",
  correcting_proposal: "proposal",
  closing_workspace: "finishing",
  saving_proposal: "finishing",
  simulation: "simulation",
}
const stageLabels: Record<Stage, string> = {
  preparation: "Workspace preparation",
  exploration: "Project exploration",
  proposal: "Proposal checks and corrections",
  finishing: "Finishing up",
  simulation: "Offline simulation",
  agent: "Agent activity",
}

export type DispatchActivityGroup = {
  id: number
  stage: Stage
  label: string
  entries: AgentActivityEntry[]
}

/** A UI projection of the retained observations, never an execution state. */
export function groupDispatchActivity(
  entries: AgentActivityEntry[]
): DispatchActivityGroup[] {
  const groups: DispatchActivityGroup[] = []
  for (const entry of entries) {
    const previous = groups.at(-1)
    const stage =
      entry.activity.kind === "phase"
        ? stages[entry.activity.phase]
        : (previous?.stage ?? "agent")
    if (previous?.stage === stage) previous.entries.push(entry)
    else
      groups.push({
        id: entry.seq,
        stage,
        label: stageLabels[stage],
        entries: [entry],
      })
  }
  return groups
}

export function activityFailures(entries: AgentActivityEntry[]): number {
  return entries.filter(
    ({ activity }) => activity.kind === "tool" && activity.status === "failed"
  ).length
}

export function activityGroupSummary(group: DispatchActivityGroup): string {
  const tools = ["read", "search", "list", "explore", "command"] as const
  const nouns = {
    read: ["file read", "file reads"],
    search: ["search", "searches"],
    list: ["file listing", "file listings"],
    explore: ["focused exploration", "focused explorations"],
    command: ["command", "commands"],
  }
  const completed = tools.flatMap((tool) => {
    const count = group.entries.filter(
      ({ activity }) =>
        activity.kind === "tool" &&
        activity.tool === tool &&
        activity.status === "completed"
    ).length
    return count ? [`${count} ${nouns[tool][count === 1 ? 0 : 1]}`] : []
  })
  const starts = group.entries.filter(
    ({ activity }) => activity.kind === "tool" && activity.status === "running"
  ).length
  const failures = activityFailures(group.entries)
  const parts = completed.length ? [`Completed ${completed.join(" · ")}`] : []
  // No invocation IDs exist yet: a start cannot be correlated with an end.
  // Count completions separately and never claim a reported start is still running.
  if (starts)
    parts.push(`${starts} tool ${starts === 1 ? "start" : "starts"} reported`)
  if (failures)
    parts.push(
      `${failures} tool ${failures === 1 ? "failure" : "failures"} reported`
    )
  return parts.length
    ? parts.join(" · ")
    : `${group.entries.length} phase ${group.entries.length === 1 ? "update" : "updates"}`
}
