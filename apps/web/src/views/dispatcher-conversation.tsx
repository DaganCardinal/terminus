import { Prose } from "@terminus/ui/components/prose"
import { Search } from "lucide-react"
import type { ReactNode } from "react"
import type {
  NetworkSnapshot,
  StoredDispatcherMessage,
  TurnErrorKind,
} from "@terminus/protocol"
import { DispatcherMessage, Typing, UserMessage } from "./dispatcher-message"
import { PlanExchange } from "./dispatcher-planner"

type Command = (run: () => Promise<unknown>) => Promise<void>

const failures: Record<TurnErrorKind, string> = {
  overloaded:
    "The model was overloaded, so I couldn't answer. Send your message again in a moment.",
  configuration:
    "I couldn't reach my model: its configuration is incomplete or not enabled for conversations. Check Settings → Agents and the Worker configuration.",
  timed_out: "The model took too long to answer. Send your message again.",
  round_limit:
    "I used every lookup a single answer is allowed before finishing. Ask a narrower question, or ask me to continue.",
  refused: "The model declined to answer that.",
  failed:
    "Something went wrong before I could answer. Send your message again.",
}

/** One line per lookup, in the user's words, never the raw result. */
export function toolActivity(
  message: Extract<StoredDispatcherMessage["message"], { kind: "tool" }>,
  snapshot: NetworkSnapshot
): string {
  const args =
    typeof message.arguments === "object" && message.arguments !== null
      ? (message.arguments as Record<string, unknown>)
      : {}
  const id = (key: string) => (typeof args[key] === "string" ? args[key] : "")
  switch (message.name) {
    case "terminus_station": {
      const station = snapshot.stations.find((s) => s.id === id("stationId"))
      return station
        ? `Looked up Station ‘${station.name}’`
        : "Looked up a Station"
    }
    case "terminus_line": {
      const line = snapshot.lines.find((l) => l.id === id("lineId"))
      return line ? `Looked up ${line.name}` : "Looked up a Line"
    }
    case "terminus_plan":
      return "Looked up a plan"
    case "terminus_activity":
      return "Read recent activity"
    case "terminus_search":
      return id("query") ? `Searched for “${id("query")}”` : "Searched"
    case "terminus_conversation":
      return "Read an earlier conversation"
    case "start_planning":
      return "Asked the planner for a plan"
    default:
      return "Looked something up"
  }
}

/** A conversation with the Dispatcher. Every message comes from the server;
 * plan messages render the plan's live card from the snapshot. */
export function ConversationThread({
  messages,
  snapshot,
  responding,
  pending,
  visible,
  command,
  openTrain,
}: {
  messages: StoredDispatcherMessage[]
  snapshot: NetworkSnapshot
  responding: boolean
  pending: boolean
  visible: boolean
  command: Command
  openTrain: (lineId: string) => void
}) {
  const items: ReactNode[] = []
  const lastPlan = messages.findLast((m) => m.message.kind === "plan")
  let lookups: string[] = []
  const flush = (key: string) => {
    if (!lookups.length) return
    items.push(
      <ul key={`tools-${key}`} className="conversation-lookups">
        {lookups.map((text, index) => (
          <li key={index}>
            <Search size={12} aria-hidden="true" />
            {text}
          </li>
        ))}
      </ul>
    )
    lookups = []
  }
  for (const { seq, at, message } of messages) {
    if (message.kind === "tool") {
      lookups.push(toolActivity(message, snapshot))
      continue
    }
    flush(String(seq))
    switch (message.kind) {
      case "user":
        items.push(<UserMessage key={seq} text={message.text} at={at} />)
        break
      case "dispatcher":
        if (message.text.trim())
          items.push(
            <DispatcherMessage key={seq}>
              <Prose text={message.text} />
            </DispatcherMessage>
          )
        break
      case "plan": {
        const plan = snapshot.plans.find((p) => p.id === message.planId)
        items.push(
          plan ? (
            <PlanExchange
              key={seq}
              plan={plan}
              snapshot={snapshot}
              // Every ready plan here can launch; only the newest unfolds.
              latest={plan.state.status === "ready" || lastPlan?.seq === seq}
              pending={pending}
              visible={visible}
              command={command}
              openTrain={openTrain}
              showGoal={false}
            />
          ) : (
            <DispatcherMessage key={seq} tone="working">
              <p className="dmsg-status" role="status">
                <Typing />
                <span>Starting the plan…</span>
              </p>
            </DispatcherMessage>
          )
        )
        break
      }
      case "stopped":
        items.push(
          <p key={seq} className="conversation-note">
            You stopped this answer.
          </p>
        )
        break
      case "error":
        items.push(
          <DispatcherMessage key={seq} tone="attention">
            <p>{failures[message.errorKind]}</p>
          </DispatcherMessage>
        )
        break
    }
  }
  flush("end")
  if (responding)
    items.push(
      <DispatcherMessage key="typing" tone="working">
        <p className="dmsg-status" role="status">
          <Typing />
          <span>Thinking…</span>
        </p>
      </DispatcherMessage>
    )
  return <>{items}</>
}
