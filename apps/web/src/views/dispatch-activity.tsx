import { ChevronDown, CircleAlert, CircleCheck, Clock3 } from "lucide-react"
import type {
  AgentActivity,
  AgentActivityEntry,
  AgentPhase,
} from "@terminus/protocol"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@terminus/ui/components/collapsible"
import { ScrollArea } from "@terminus/ui/components/scroll-area"
import { Button } from "@terminus/ui/components/button"

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
    read: ["Reading a file", "Read a file"],
    search: ["Searching the project", "Searched the project"],
    list: ["Listing project files", "Listed project files"],
    explore: ["Running focused exploration", "Completed focused exploration"],
    command: ["Running a command", "Ran a command"],
  }
  const label = labels[activity.tool][activity.status === "completed" ? 1 : 0]!
  return activity.status === "failed" ? `${label} · failed` : label
}

function ActivityRows({ entries }: { entries: AgentActivityEntry[] }) {
  return (
    <ol
      className="dispatch-activity-list"
      aria-label="Dispatcher execution activity"
    >
      {[...entries].reverse().map(({ seq, at, activity }) => {
        const Icon =
          activity.kind === "tool" && activity.status === "failed"
            ? CircleAlert
            : activity.kind === "tool" && activity.status === "completed"
              ? CircleCheck
              : Clock3
        return (
          <li key={seq}>
            <Icon size={13} aria-hidden="true" />
            <span>
              {activityLabel(activity)}
              {activity.kind === "tool" && activity.path && (
                <code>{activity.path}</code>
              )}
            </span>
            <time dateTime={at}>
              {new Date(at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </time>
          </li>
        )
      })}
    </ol>
  )
}

export function DispatchActivity({
  entries,
  running,
  unavailable,
}: {
  entries: AgentActivityEntry[]
  running: boolean
  unavailable: boolean
}) {
  if (!entries.length && !unavailable) return null
  return (
    <div className="dispatch-activity">
      {running && <ActivityRows entries={entries.slice(-3)} />}
      {entries.length > 0 && (!running || entries.length > 3) && (
        <Collapsible>
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="dispatch-activity-trigger"
              />
            }
          >
            <ChevronDown size={13} />{" "}
            {running ? "View activity" : "Execution activity"}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ScrollArea className="dispatch-activity-scroll">
              <ActivityRows entries={entries} />
            </ScrollArea>
            <p className="dmsg-hint">
              Showing up to 200 recent observations from this attempt.
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}
      {unavailable && (
        <p className="dmsg-hint" role="status">
          Activity updates are temporarily unavailable.
        </p>
      )}
    </div>
  )
}
