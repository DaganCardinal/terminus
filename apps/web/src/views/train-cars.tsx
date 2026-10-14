import { Prose } from "@terminus/ui/components/prose"
import type { Car, NetworkSnapshot, Station } from "@terminus/protocol"
import { useId, useRef, useState, type CSSProperties } from "react"
import { TrainFront, X } from "lucide-react"
import type { MapSelection } from "@/map/network-map"
import { CheckRow, List, ManifestView, TechnicalDetails } from "./detail-parts"
import { namesFor } from "./describe"
import { Changes } from "./changes"

const MAX_PENDING_CARS = 12
const loading = new Set([
  "signaled",
  "active",
  "ready_for_pickup",
  "in_review",
  "revising",
])

/** The diagram is the selector for one accepted Car's details. */
export function TrainCars({
  color,
  cars,
  stations,
  snapshot,
  onSelect,
}: {
  color: string
  cars: Car[]
  stations: Station[]
  snapshot: NetworkSnapshot
  onSelect: (selection: MapSelection) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedButton = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const headingId = useId()
  const name = namesFor(snapshot)
  const title = (car: Car) =>
    snapshot.stations.find((station) => station.id === car.stationId)?.name ??
    car.manifest.goal
  const car = cars.find((candidate) => candidate.id === selectedId)
  const open = stations.filter(
    (station) =>
      station.state.status !== "complete" &&
      station.state.status !== "cancelled"
  )
  const loadingCount = open.filter((station) =>
    loading.has(station.state.status)
  ).length

  return (
    <div className="train-cars" style={{ "--line": color } as CSSProperties}>
      <div className="consist-wrap">
        <div className="consist-scroll">
          <div
            className="consist"
            role="group"
            aria-label={`${cars.length} accepted ${cars.length === 1 ? "Car" : "Cars"}, ${open.length} Stations to go`}
          >
            <span className="consist-loco" aria-hidden="true">
              <TrainFront size={13} />
            </span>
            {[...cars]
              .sort((a, b) => a.position - b.position)
              .map((accepted) => (
                <button
                  key={accepted.id}
                  type="button"
                  ref={car?.id === accepted.id ? selectedButton : undefined}
                  className="consist-car consist-accepted"
                  title={title(accepted)}
                  aria-label={`Car ${accepted.position}: ${title(accepted)}`}
                  aria-expanded={car?.id === accepted.id}
                  aria-controls={panelId}
                  onClick={() =>
                    setSelectedId(car?.id === accepted.id ? null : accepted.id)
                  }
                >
                  {accepted.position}
                </button>
              ))}
            {open.slice(0, MAX_PENDING_CARS).map((station) => (
              <span
                key={station.id}
                className={`consist-car consist-${loading.has(station.state.status) ? "loading" : station.state.status === "blocked" ? "blocked" : "planned"}`}
                role="img"
                aria-label={`${station.name}, ${station.state.status.replaceAll("_", " ")}`}
                title={`${station.name} · ${station.state.status.replaceAll("_", " ")}`}
              />
            ))}
            {open.length > MAX_PENDING_CARS && (
              <span className="consist-more">
                +{open.length - MAX_PENDING_CARS} to go
              </span>
            )}
          </div>
        </div>
        <p className="detail-note">
          {cars.length} accepted
          {loadingCount > 0 && ` · ${loadingCount} loading`}
          {open.length - loadingCount > 0 &&
            ` · ${open.length - loadingCount} to go`}
        </p>
      </div>
      {!car && cars.length > 0 && (
        <p className="detail-note">
          Select a Car to inspect its accepted work.
        </p>
      )}
      <div id={panelId} role="region" aria-labelledby={headingId} hidden={!car}>
        {car && (
          <div key={car.id} className="car-details">
            <div className="car-details-heading">
              <h4 id={headingId}>
                Car {car.position} · {title(car)}
              </h4>
              <button
                type="button"
                className="car-details-close"
                aria-label="Close Car details"
                onClick={() => {
                  selectedButton.current?.focus()
                  setSelectedId(null)
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <Prose text={car.manifest.goal} />
            {car.originCarId && (
              <p>
                Picked up from{" "}
                <button
                  className="dmsg-link"
                  onClick={() => {
                    const origin = snapshot.cars.find(
                      (c) => c.id === car.originCarId
                    )
                    const t = snapshot.trains.find(
                      (t) => t.train.id === origin?.trainId
                    )
                    if (t)
                      onSelect({
                        lineId: t.train.lineId,
                        stationId: car.stationId,
                      })
                  }}
                >
                  original Car {car.originCarId}
                </button>
                . Original acceptance and review are preserved.
              </p>
            )}
            <h4>Conductor review</h4>
            <Prose text={car.review.summary} />
            <List items={car.review.findings} />
            <CheckRow checks={car.evidence.checks} />
            <ManifestView manifest={car.manifest} name={name} met />
            <TechnicalDetails
              facts={[
                { label: "Accepted commit", value: car.acceptedCommit },
                { label: "Changed files", value: car.changedPaths },
              ]}
            />
            <Changes
              target={{
                trainId: car.trainId,
                carId: car.id,
                base: car.sourceCommit,
                head: car.acceptedCommit,
              }}
              description="Work accepted into this Car."
            />
          </div>
        )}
      </div>
    </div>
  )
}
