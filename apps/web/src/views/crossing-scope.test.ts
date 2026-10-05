import { expect, it } from "vitest"
import type {
  DispatchProposal,
  NetworkSnapshot,
  WorkManifest,
} from "@terminus/protocol"
import { crossingScope } from "./crossing-scope"
const manifest = (path: string): WorkManifest => ({
  goal: path,
  scope: [],
  expectedAreas: [path],
  avoidAreas: [],
  contracts: [],
  invariants: [],
  dependencies: [],
  acceptanceCriteria: [],
  expectedEvidence: [],
})
const snapshot: NetworkSnapshot = {
  network: {
    id: "n",
    name: "Network",
    terminusRepoId: "repo",
    terminusCommit: "base",
    createdAt: "now",
  },
  lines: [],
  stations: [],
  trains: [],
  cars: [],
  holds: [],
  conflicts: [],
  plans: [],
  lastSeq: 0,
}
it("shows the source direction and inherited scope in route order, excluding later work and including chained pickup", () => {
  const lines: DispatchProposal["lines"] = [
    {
      key: "a",
      name: "Source A",
      stations: [
        { key: "a-later", name: "Later", manifest: manifest("later.ts") },
        { key: "a-1", name: "First", manifest: manifest("api.ts") },
        { key: "a-2", name: "Checkpoint", manifest: manifest("test.ts") },
      ],
      route: [
        { kind: "station", key: "a-1" },
        { kind: "station", key: "a-2" },
        { kind: "station", key: "a-later" },
      ],
    },
    {
      key: "b",
      name: "Source B",
      stations: [
        { key: "b-1", name: "Consumer", manifest: manifest("consumer.ts") },
      ],
      route: [
        { kind: "crossing", source: { kind: "planned", stationKey: "a-2" } },
        { kind: "station", key: "b-1" },
      ],
    },
  ]
  expect(
    crossingScope(lines, snapshot, { kind: "planned", stationKey: "b-1" })
  ).toEqual({
    station: "Consumer",
    line: "Source B",
    areas: ["api.ts", "test.ts", "consumer.ts"],
  })
})
