import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { Junction, NetworkSnapshot } from "@terminus/protocol"
import { JunctionDetails } from "./junctions"

const line = (id: string, name: string) => ({
  id,
  name,
  networkId: "network",
  stationIds: [],
  createdAt: "2026-10-14T00:00:00.000Z",
})

function render(state: Junction["state"], accepted = 1) {
  const junction = {
    id: "junction",
    networkId: "network",
    name: "Customer profile",
    repoId: "ns/junction",
    terminusBaseline: "a".repeat(40),
    headCommit: "b".repeat(40),
    incomingLineIds: ["l0", "l1"],
    incomingTrainIds: ["t0", "t1"],
    outgoingLineId: "l2",
    outgoingTrainId: "t2",
    outgoingUnloadMode: "auto",
    brief: {
      goal: "Assemble the profile",
      scope: ["src/customers"],
      contracts: [],
      invariants: [],
      acceptanceCriteria: ["All parts render together"],
      validation: [{ name: "test", command: ["npm", "test"] }],
    },
    conductorModel: "fake",
    createdAt: "2026-10-14T00:00:00.000Z",
    inputs: Array.from({ length: accepted }, (_, i) => ({
      trainId: `t${i}`,
      lineId: `l${i}`,
      sourceCommit: "c".repeat(40),
      integrationId: `i${i}`,
      mergeCommit: `${i}`.repeat(40),
      carIds: [],
    })),
    repairIds: [],
    attempt: 0,
    state,
  } as Junction
  const snapshot = {
    network: { id: "network", name: "Demo", createdAt: "" },
    lines: [
      line("l0", "Profile header"),
      line("l1", "Ticket history"),
      line("l2", "Connect profile"),
    ],
    trains: [],
    stations: [],
    cars: [],
    conflicts: [],
    junctions: [junction],
  } as unknown as NetworkSnapshot
  return renderToStaticMarkup(
    <JunctionDetails
      junction={junction}
      snapshot={snapshot}
      run={async () => {}}
      pending={false}
      onSource={() => {}}
    />
  )
}

describe("Junction details", () => {
  it("shows collection progress and the route to Terminus", () => {
    const html = render({ status: "collecting" })
    expect(html).toContain("Collecting inputs")
    expect(html).toContain('aria-valuenow="1"')
    expect(html).toContain("1 of 2 inputs accepted")
    for (const name of [
      "Profile header",
      "Ticket history",
      "Connect profile",
      "Terminus",
    ])
      expect(html).toContain(name)
    expect(html).toContain("#1 ·")
    expect(html).not.toContain("Approve and release feature")
  })
  it("leads with the release action once the feature is ready", () => {
    const html = render({ status: "ready" }, 2)
    expect(html).toContain("Ready for your release")
    expect(html).toContain("Approve and release feature")
  })
  it("offers recovery while blocked", () => {
    const html = render({
      status: "blocked",
      issues: [{ kind: "integration_failed", detail: "Merge conflict" }],
    } as Junction["state"])
    expect(html).toContain("Merge conflict")
    expect(html).toContain("Retry convergence")
    expect(html).toContain("Dispatch Technician")
  })
  it("asks before abandoning", () => {
    const html = render({ status: "collecting" })
    expect(html).toContain("Abandon Junction")
    expect(html).not.toContain("Abandon Customer profile")
  })
})
