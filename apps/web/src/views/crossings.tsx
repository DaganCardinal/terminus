import { useEffect, useState } from "react"
import type { Crossing, NetworkSnapshot } from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { api } from "@/state/api"
import { CheckRow, TechnicalDetails, shortCommit } from "./detail-parts"

type Details = Awaited<ReturnType<typeof api.crossing>>
export function Crossings({
  snapshot,
  lineId,
  run,
  pending,
  onSource,
}: {
  snapshot: NetworkSnapshot
  lineId: string
  run: (command: () => Promise<unknown>) => Promise<void>
  pending: boolean
  onSource: (lineId: string, stationId: string) => void
}) {
  const items = (snapshot.crossings ?? []).filter((c) => c.lineId === lineId)
  if (!items.length) return null
  return (
    <section className="detail-section">
      <h3>Crossing pickups</h3>
      {items.map((c) => (
        <CrossingItem
          key={c.id}
          crossing={c}
          snapshot={snapshot}
          run={run}
          pending={pending}
          onSource={onSource}
        />
      ))}
    </section>
  )
}
function CrossingItem({
  crossing: c,
  snapshot,
  run,
  pending,
  onSource,
}: {
  crossing: Crossing
  snapshot: NetworkSnapshot
  run: (command: () => Promise<unknown>) => Promise<void>
  pending: boolean
  onSource: (lineId: string, stationId: string) => void
}) {
  const [details, setDetails] = useState<Details | null>(null),
    [error, setError] = useState<string | null>(null),
    [open, setOpen] = useState(false)
  const source = snapshot.stations.find((s) => s.id === c.sourceStationId)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    api
      .crossing(c.id)
      .then((d) => {
        if (!cancelled) {
          setDetails(d)
          setError(null)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [open, c.id, snapshot.lastSeq])
  const checkpoint = c.checkpoint ?? details?.checkpoint
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {source?.name ?? c.sourceStationId} · {c.state.status}
      </summary>
      <p>
        {snapshot.lines.find((l) => l.id === source?.lineId)?.name ??
          "Source Line"}{" "}
        → {snapshot.lines.find((l) => l.id === c.lineId)?.name}. Pickup includes
        all Cars through this Station.
      </p>
      {source && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onSource(source.lineId, source.id)}
        >
          Inspect source Station
        </Button>
      )}
      {checkpoint && (
        <p>
          {checkpoint.carIds.length} Cars at {shortCommit(checkpoint.commit)}.
        </p>
      )}
      {c.state.status === "complete" && (
        <p>
          {c.state.copiedCarIds.length} Cars copied;{" "}
          {(checkpoint?.carIds.length ?? 0) - c.state.copiedCarIds.length}{" "}
          already carried.
        </p>
      )}
      {checkpoint && details && (
        <ul>
          {checkpoint.carIds.map((id) => {
            const sourceCar = details.cars.find((car) => car.id === id)
            if (!sourceCar) return null
            const root = sourceCar.originCarId ?? sourceCar.id
            const receiving = snapshot.cars.find(
              (car) =>
                snapshot.trains.some(
                  (t) =>
                    t.train.id === car.trainId && t.train.lineId === c.lineId
                ) && (car.originCarId ?? car.id) === root
            )
            return (
              <li key={id}>
                {snapshot.stations.find((s) => s.id === sourceCar.stationId)
                  ?.name ?? sourceCar.manifest.goal}
                {receiving
                  ? receiving.crossingId === c.id
                    ? " · copied"
                    : " · already carried"
                  : " · awaiting pickup"}
              </li>
            )
          })}
        </ul>
      )}
      {c.state.status === "blocked" && (
        <>
          <ul>
            {c.state.issues.map((i, n) => (
              <li key={n}>{i.detail}</li>
            ))}
          </ul>
          <Button
            disabled={pending || c.retryRequested}
            onClick={() => void run(() => api.retryCrossing(c.id))}
          >
            Retry pickup
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              const t = snapshot.trains.find((t) => t.train.lineId === c.lineId)
              if (t)
                void run(() =>
                  api.sideTrain(t.train.id, "Abandoned after Crossing failure")
                )
            }}
          >
            Move Train to siding
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {details?.attempts.map((a) => (
        <details key={a.input.id}>
          <summary>
            Attempt {a.input.id} · {a.status}
          </summary>
          <TechnicalDetails
            facts={[
              { label: "Source checkpoint", value: a.input.trainCommit },
              { label: "Receiving commit", value: a.input.terminusCommit },
              {
                label: "Candidate",
                value: a.candidate?.headCommit ?? "Not prepared",
              },
            ]}
          />
          {a.evidence && <CheckRow checks={a.evidence.checks} />}
          <p>{a.review?.summary}</p>
          {a.review?.findings.length ? (
            <ul>
              {a.review.findings.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          ) : null}
          {a.result && !a.result.ok && (
            <ul>
              {a.result.issues.map((i, n) => (
                <li key={n}>{i.detail}</li>
              ))}
            </ul>
          )}
          {a.diff !== undefined && (
            <pre className="unload-diff">
              {a.diff || "Source snapshot already present; no file changes."}
            </pre>
          )}
        </details>
      ))}
    </details>
  )
}
