import type {
  EventEnvelope,
  Line,
  NetworkSnapshot,
  TrainView,
} from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { useState } from "react"
import { SignalLamp, StatusBadge } from "@/components/status-badge"
import { api } from "@/state/api"
import { useNetwork } from "@/state/use-network"
import { describeEvent, describeLocation, namesFor } from "./describe"

export function NetworkStatus({ networkId }: { networkId: string }) {
  const { snapshot, events, error } = useNetwork(networkId)
  const [commandError, setCommandError] = useState<string | null>(null)

  async function run(command: () => Promise<unknown>) {
    try {
      setCommandError(null)
      await command()
    } catch (caught) {
      setCommandError(String(caught))
    }
  }

  if (!snapshot) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }
  const name = namesFor(snapshot)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{snapshot.network.name}</h1>
          <p className="font-mono text-xs text-muted-foreground">
            Terminus {snapshot.network.terminusRepoId} @{" "}
            {snapshot.network.terminusCommit}
          </p>
        </div>
        {snapshot.lines.length === 0 && (
          <Button onClick={() => run(() => api.layDemoLines(networkId))}>
            Lay demo Lines
          </Button>
        )}
      </header>

      {(error || commandError) && (
        <p className="text-sm text-destructive">{commandError ?? error}</p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
        <section className="flex flex-col gap-4">
          {snapshot.lines.map((line) => (
            <LineCard
              key={line.id}
              line={line}
              snapshot={snapshot}
              name={name}
              onHold={() =>
                run(() =>
                  api.placeHold(networkId, {
                    kind: "user",
                    scope: { kind: "line", lineId: line.id },
                    note: `Hold on ${line.name}`,
                  })
                )
              }
              onClear={(trainId) => run(() => api.clearTrain(trainId))}
            />
          ))}
          {snapshot.holds.length > 0 && (
            <div className="rounded-md border border-border p-4">
              <h2 className="mb-2 text-sm font-medium">Active holds</h2>
              <ul className="flex flex-col gap-2">
                {snapshot.holds.map((hold) => (
                  <li
                    key={hold.id}
                    className="flex items-center justify-between text-sm"
                  >
                    <span>
                      {hold.note || hold.kind}{" "}
                      <span className="text-muted-foreground">
                        ({hold.kind} ·{" "}
                        {hold.scope.kind === "line"
                          ? name(hold.scope.lineId)
                          : hold.scope.kind}
                        )
                      </span>
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        run(() => api.releaseHold(networkId, hold.id))
                      }
                    >
                      Release
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <EventFeed events={events} name={name} />
      </div>
    </div>
  )
}

function LineCard({
  line,
  snapshot,
  name,
  onHold,
  onClear,
}: {
  line: Line
  snapshot: NetworkSnapshot
  name: (id: string) => string
  onHold: () => void
  onClear: (trainId: string) => void
}) {
  const view = snapshot.trains.find(({ train }) => train.lineId === line.id)
  const stations = line.stationIds.map((id) =>
    snapshot.stations.find((station) => station.id === id)!
  )

  return (
    <article className="rounded-md border border-border">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-medium">{line.name}</h2>
        <Button size="xs" variant="outline" onClick={onHold}>
          Hold Line
        </Button>
      </header>
      {view && (
        <TrainRow
          view={view}
          snapshot={snapshot}
          name={name}
          onClear={onClear}
        />
      )}
      <ol className="flex flex-col divide-y divide-border">
        {stations.map((station, index) => (
          <li
            key={station.id}
            className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
          >
            <span>
              <span className="mr-2 text-muted-foreground">{index + 1}.</span>
              {station.name}
              {station.revisionCount > 0 && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {station.revisionCount} revision
                  {station.revisionCount === 1 ? "" : "s"}
                </span>
              )}
            </span>
            <StatusBadge status={station.state.status} />
          </li>
        ))}
        <li className="px-4 py-2 text-sm text-muted-foreground">Terminus</li>
      </ol>
    </article>
  )
}

function TrainRow({
  view,
  snapshot,
  name,
  onClear,
}: {
  view: TrainView
  snapshot: NetworkSnapshot
  name: (id: string) => string
  onClear: (trainId: string) => void
}) {
  const { train, signal } = view
  const cars = snapshot.cars.filter((car) => car.trainId === train.id)
  return (
    <div className="flex flex-col gap-2 bg-muted/40 px-4 py-3 text-sm">
      <div className="flex items-center gap-2">
        <SignalLamp signal={signal} />
        <span className="font-medium">Train</span>
        <StatusBadge status={train.state.status} />
        <span className="text-muted-foreground">
          {describeLocation(train.state, name)}
        </span>
        {train.state.status === "blocked" && (
          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            onClick={() => onClear(train.id)}
          >
            Clear
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 font-mono text-xs text-muted-foreground">
        <span>
          {cars.length} Car{cars.length === 1 ? "" : "s"}
        </span>
        {cars.map((car) => (
          <span
            key={car.id}
            title={`${car.acceptedCommit}\n${car.review.summary}`}
            className="rounded border border-border bg-background px-1.5 py-0.5"
          >
            {name(car.stationId)}
          </span>
        ))}
        <span className="ml-auto">head {train.headCommit}</span>
      </div>
    </div>
  )
}

function EventFeed({
  events,
  name,
}: {
  events: EventEnvelope[]
  name: (id: string) => string
}) {
  return (
    <aside className="flex max-h-[80vh] flex-col rounded-md border border-border">
      <h2 className="border-b border-border px-4 py-3 text-sm font-medium">
        Events
      </h2>
      <ol className="flex flex-col overflow-y-auto">
        {[...events].reverse().map((envelope) => (
          <li
            key={envelope.seq}
            className="flex gap-3 border-b border-border px-4 py-2 text-xs last:border-b-0"
          >
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {new Date(envelope.occurredAt).toLocaleTimeString()}
            </span>
            <span>{describeEvent(envelope.event, name)}</span>
          </li>
        ))}
      </ol>
    </aside>
  )
}
