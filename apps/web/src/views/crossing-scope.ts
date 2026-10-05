import type { DispatchProposal, NetworkSnapshot } from "@terminus/protocol"

type PlannedLine = DispatchProposal["lines"][number]
type Source = Extract<
  NonNullable<PlannedLine["route"]>[number],
  { kind: "crossing" }
>["source"]

/** Display inherited intent through a checkpoint; execution remains backend-owned. */
export function crossingScope(
  lines: PlannedLine[],
  snapshot: NetworkSnapshot,
  source: Source
) {
  const areas = new Set<string>(),
    visited = new Set<string>()
  const collect = (ref: Source): { station: string; line: string } => {
    const id = ref.kind === "planned" ? ref.stationKey : ref.stationId
    const planned =
      ref.kind === "planned"
        ? lines.find((l) => l.stations.some((s) => s.key === id))
        : undefined
    const station =
      ref.kind === "planned"
        ? planned?.stations.find((s) => s.key === id)
        : snapshot.stations.find((s) => s.id === id)
    const owner =
      ref.kind === "existing"
        ? snapshot.lines.find(
            (l) => l.id === snapshot.stations.find((s) => s.id === id)?.lineId
          )
        : undefined
    const label = {
      station: station?.name ?? id,
      line: planned?.name ?? owner?.name ?? "Source Line",
    }
    const identity = `${ref.kind}:${id}`
    if (visited.has(identity)) return label
    visited.add(identity)
    if (planned) {
      const route =
        planned.route ??
        planned.stations.map((s) => ({ kind: "station" as const, key: s.key }))
      for (const stop of route) {
        if (stop.kind === "crossing") collect(stop.source)
        else {
          planned.stations
            .find((s) => s.key === stop.key)
            ?.manifest.expectedAreas.forEach((a) => areas.add(a))
          if (stop.key === id) break
        }
      }
    } else if (owner) {
      const accepted = snapshot.stations.find((s) => s.id === id)?.state
      const carId = accepted?.status === "complete" ? accepted.carId : undefined
      const train = snapshot.trains.find(
        (t) => t.train.lineId === owner.id
      )?.train
      const index = carId && train ? train.carIds.indexOf(carId) : -1
      if (train && index >= 0) {
        train.carIds
          .slice(0, index + 1)
          .forEach((carId) =>
            snapshot.cars
              .find((c) => c.id === carId)
              ?.changedPaths.forEach((a) => areas.add(a))
          )
      } else {
        for (const stop of owner.stops ??
          owner.stationIds.map((stationId) => ({
            kind: "station" as const,
            stationId,
          }))) {
          if (stop.kind === "crossing")
            collect({ kind: "existing", stationId: stop.stationId })
          else
            snapshot.stations
              .find((s) => s.id === stop.stationId)
              ?.manifest.expectedAreas.forEach((a) => areas.add(a))
          if (stop.kind === "station" && stop.stationId === id) break
        }
      }
    }
    return label
  }
  return { ...collect(source), areas: [...areas] }
}
