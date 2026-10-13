import { useState } from "react"
import { ChevronDown, CircleAlert, CircleCheck, Clock3 } from "lucide-react"
import type { AgentActivityEntry } from "@terminus/protocol"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@terminus/ui/components/collapsible"
import { ScrollArea } from "@terminus/ui/components/scroll-area"
import { Button } from "@terminus/ui/components/button"
import { TypedText } from "@terminus/ui/components/typed-text"
import {
  activityFailures,
  activityGroupSummary,
  activityLabel,
  groupDispatchActivity,
  type DispatchActivityGroup,
} from "@/state/dispatch-activity"

function ActivityRows({
  entries,
  running,
}: {
  entries: AgentActivityEntry[]
  running: boolean
}) {
  // Opening details restores all existing rows immediately. Only rows arriving
  // while these details are mounted get a reveal.
  const [initialSeq] = useState(entries.at(-1)?.seq ?? 0)
  return (
    <ol
      className="dispatch-activity-list"
      aria-label="Dispatcher execution activity"
    >
      {entries.map(({ seq, at, activity }) => {
        const Icon =
          activity.kind === "tool" && activity.status === "failed"
            ? CircleAlert
            : activity.kind === "tool" && activity.status === "completed"
              ? CircleCheck
              : Clock3
        return (
          <li
            key={seq}
            className={
              activity.kind === "tool" && activity.status === "failed"
                ? "dispatch-activity-failed"
                : undefined
            }
          >
            <Icon size={13} aria-hidden="true" />
            <span>
              <TypedText
                text={activityLabel(activity)}
                animate={
                  running &&
                  seq > initialSeq &&
                  !(activity.kind === "tool" && activity.status === "failed")
                }
              />
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

function ActivityGroup({
  group,
  open,
  onOpenChange,
  animate,
  running,
}: {
  group: DispatchActivityGroup
  open: boolean
  onOpenChange: (open: boolean) => void
  animate: boolean
  running: boolean
}) {
  return (
    <Collapsible
      className="dispatch-activity-group"
      open={open}
      onOpenChange={onOpenChange}
    >
      <CollapsibleTrigger
        render={
          <Button variant="ghost" className="dispatch-activity-group-trigger" />
        }
      >
        <span>
          <span className="dispatch-activity-group-label">
            <TypedText text={group.label} animate={animate} />
          </span>
          <span className="dispatch-activity-group-summary">
            {activityGroupSummary(group)}
          </span>
        </span>
        <ChevronDown size={13} aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="dispatch-activity-group-details">
        <ActivityRows entries={group.entries} running={running} />
      </CollapsibleContent>
    </Collapsible>
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
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const [initialSeq, setInitialSeq] = useState<number | null>(
    () => entries.at(-1)?.seq ?? null
  )
  // The first snapshot can arrive asynchronously. Treat it as restored history,
  // then reveal labels from later observations only.
  if (initialSeq === null && entries.length > 0)
    setInitialSeq(entries.at(-1)!.seq)
  const groups = groupDispatchActivity(entries)
  const latest = running ? groups.at(-1) : undefined
  const history = latest ? groups.slice(0, -1) : groups
  const failures = activityFailures(entries)
  const renderGroup = (group: DispatchActivityGroup) => (
    <ActivityGroup
      key={group.id}
      group={group}
      open={expanded[group.id] ?? false}
      animate={
        initialSeq !== null && group.id > initialSeq && group.id === latest?.id
      }
      running={running && group.id === latest?.id}
      onOpenChange={(open) =>
        setExpanded((before) => ({ ...before, [group.id]: open }))
      }
    />
  )
  if (!entries.length && !unavailable) return null
  return (
    <div className="dispatch-activity">
      {failures > 0 && (
        <p className="dispatch-activity-failures" role="status">
          <CircleAlert size={13} aria-hidden="true" />
          <span>
            {failures} tool {failures === 1 ? "failure" : "failures"} reported
            in recent activity. Expand the activity groups for details.
          </span>
        </p>
      )}
      {latest && renderGroup(latest)}
      {history.length > 0 && (
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
            {running ? "Earlier activity" : "Execution activity"} ·{" "}
            {history.length} {history.length === 1 ? "group" : "groups"}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ScrollArea className="dispatch-activity-scroll">
              <div className="dispatch-activity-groups">
                {history.map(renderGroup)}
              </div>
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
