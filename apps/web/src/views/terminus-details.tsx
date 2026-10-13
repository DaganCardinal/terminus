import { ArrowUpRight, CircleCheck } from "lucide-react"
import type { NetworkSnapshot } from "@terminus/protocol"
import { shortCommit, TechnicalDetails } from "./detail-parts"
import { TerminusPreviewButton } from "./terminus-preview-button"
import { TerminusPublish } from "./terminus-publish"
import { EmergencyBrakeButton } from "./emergency-brake-button"

export function TerminusDetails({
  snapshot,
  openTrain,
}: {
  snapshot: NetworkSnapshot
  openTrain: (lineId: string) => void
}) {
  const { network } = snapshot
  const unloaded = snapshot.trains
    .filter(
      ({ train }) =>
        train.state.status === "unloaded" &&
        train.state.destination?.kind !== "junction"
    )
    .sort((a, b) => b.stateEnteredAt.localeCompare(a.stateEnteredAt))
  const integratedIds = new Set(unloaded.map(({ train }) => train.id))
  const cars = snapshot.cars.filter((car) => integratedIds.has(car.trainId))

  return (
    <>
      <p className="detail-lead">
        The canonical application, combining work that passed Terminus
        integration checks. Work still on a Train stays separate until it
        unloads.
      </p>
      <p className="terminus-commit">
        Current snapshot{" "}
        <code title={network.terminusCommit}>
          {shortCommit(network.terminusCommit)}
        </code>
      </p>
      <TerminusPreviewButton
        networkId={network.id}
        commit={network.terminusCommit}
      />
      <TerminusPublish
        network={network}
        newerTrains={
          network.publication
            ? unloaded.filter(
                ({ stateEnteredAt }) =>
                  stateEnteredAt > network.publication!.publishedAt
              ).length
            : 0
        }
      />
      <section className="detail-section">
        <h3>Integrated work</h3>
        {unloaded.length === 0 ? (
          <p>
            No Trains have unloaded yet. You can preview the starting
            application while work proceeds on the Lines.
          </p>
        ) : (
          <>
            <p>
              {unloaded.length} {unloaded.length === 1 ? "Train" : "Trains"}{" "}
              unloaded · {cars.length} accepted{" "}
              {cars.length === 1 ? "Car" : "Cars"}
            </p>
            <ul className="terminus-integrations">
              {unloaded.map(({ train }) => {
                const line = snapshot.lines.find(
                  (line) => line.id === train.lineId
                )
                const accepted = snapshot.cars.filter(
                  (car) => car.trainId === train.id
                )
                return (
                  <li key={train.id}>
                    <button onClick={() => openTrain(train.lineId)}>
                      <CircleCheck size={16} aria-hidden="true" />
                      <span>
                        <strong>{line?.name ?? "Unloaded Train"}</strong>
                        <span>
                          {accepted.length}{" "}
                          {accepted.length === 1 ? "Car" : "Cars"} · View
                          changes and reviews
                        </span>
                      </span>
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </section>
      <TechnicalDetails
        facts={[{ label: "Canonical commit", value: network.terminusCommit }]}
      />
      <section className="detail-section">
        <h3>Station controls</h3>
        <EmergencyBrakeButton networkId={network.id} />
      </section>
    </>
  )
}
