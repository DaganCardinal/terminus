import type { EventEnvelope, NetworkSnapshot } from "@terminus/protocol"
import { useNow } from "@/components/use-now"
import { describeEvent, namesFor } from "./describe"
import { dayLabel, presentEvent, type EventTone } from "./event-presentation"
import { NamedText } from "./named-text"

const SEVERITY_LABEL: Partial<Record<EventTone, string>> = {
  warning: "Warning",
  danger: "Needs attention",
}

/** Network events, newest first, on a timeline grouped by day. */
export function ActivityFeed({
  events,
  snapshot,
}: {
  events: EventEnvelope[]
  snapshot: NetworkSnapshot
}) {
  const now = new Date(useNow(60_000))
  const name = namesFor(snapshot)
  if (events.length === 0)
    return (
      <p className="detail-lead">
        No events yet. Activity appears here as the network changes.
      </p>
    )

  const days: { label: string; events: EventEnvelope[] }[] = []
  for (const envelope of [...events].reverse().slice(0, 100)) {
    const label = dayLabel(new Date(envelope.occurredAt), now)
    const day = days.at(-1)
    if (day?.label === label) day.events.push(envelope)
    else days.push({ label, events: [envelope] })
  }

  return (
    <div className="activity-feed">
      {days.map((day) => (
        <section key={day.label}>
          <h3 className="activity-day">{day.label}</h3>
          <ol>
            {day.events.map((envelope) => {
              const { icon: Icon, tone } = presentEvent(envelope.event)
              const at = new Date(envelope.occurredAt)
              const severity = SEVERITY_LABEL[tone]
              return (
                <li key={envelope.seq} className={`activity-${tone}`}>
                  <span className="activity-badge" aria-hidden="true">
                    <Icon size={14} />
                  </span>
                  <p>
                    {severity && <span className="sr-only">{severity}: </span>}
                    <NamedText
                      describe={(named) => describeEvent(envelope.event, named)}
                      name={name}
                    />
                  </p>
                  <time
                    dateTime={envelope.occurredAt}
                    title={at.toLocaleString()}
                  >
                    {at.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </time>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}
