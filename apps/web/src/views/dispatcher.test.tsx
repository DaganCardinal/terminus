import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { NetworkSnapshot } from "@terminus/protocol"
import { DispatcherPanel } from "./dispatcher"

function render(planning: boolean) {
  const snapshot = {
    network: { id: "network", name: "Demo" },
    lines: [],
    trains: [],
    stations: [],
    conflicts: [],
    repairs: [],
    plans: planning
      ? [
          {
            id: "dispatch-test",
            goal: "Add a footer",
            terminusCommit: "a".repeat(40),
            createdAt: new Date().toISOString(),
            state: { status: "planning" },
          },
        ]
      : [],
  } as unknown as NetworkSnapshot
  return renderToStaticMarkup(
    <DispatcherPanel
      snapshot={snapshot}
      open
      mobile={false}
      onClose={() => {}}
      onResize={() => {}}
      openTrain={() => {}}
    />
  )
}
describe("Dispatcher composer", () => {
  it("offers an enabled Stop after a refresh with planning in progress and an empty draft", () => {
    const html = render(true)
    expect(html).toMatch(
      /<button type="button" class="composer-send composer-stop" aria-label="Stop Dispatcher planning">Stop<\/button>/
    )
    expect(html).not.toContain('aria-label="Send goal to the Dispatcher"')
  })
  it("returns to Send while idle", () => {
    const html = render(false)
    expect(html).toContain('aria-label="Send goal to the Dispatcher"')
    expect(html).not.toContain('aria-label="Stop Dispatcher planning"')
  })
})

function renderJunctionPlan() {
  const line = (name: string, stations: string[]) => ({
    name,
    stations: stations.map((s) => ({
      key: s.toLowerCase().replaceAll(" ", "-"),
      name: s,
      manifest: { goal: s },
    })),
  })
  const snapshot = {
    network: { id: "network", name: "Demo", terminusCommit: "a".repeat(40) },
    lines: [],
    trains: [],
    stations: [],
    conflicts: [],
    repairs: [],
    plans: [
      {
        id: "dispatch-test",
        goal: "Build a customer profile",
        terminusCommit: "a".repeat(40),
        model: "fake",
        createdAt: new Date().toISOString(),
        state: {
          status: "ready",
          assessment: { errors: [], collisions: [] },
          proposal: {
            summary: "Four parts converge at a Junction.",
            lines: [],
            junctions: [
              {
                key: "profile",
                name: "Customer profile",
                brief: {
                  goal: "Assemble the profile",
                  scope: ["src/customers"],
                  contracts: [],
                  invariants: [],
                  acceptanceCriteria: ["All four parts render together"],
                  validation: [{ name: "test", command: "npm test" }],
                },
                incoming: [
                  line("Profile header", ["Header"]),
                  line("Ticket history", ["History"]),
                ],
                outgoing: line("Connect profile", ["Route"]),
              },
            ],
          },
        },
      },
    ],
  } as unknown as NetworkSnapshot
  return renderToStaticMarkup(
    <DispatcherPanel
      snapshot={snapshot}
      open
      mobile={false}
      onClose={() => {}}
      onResize={() => {}}
      openTrain={() => {}}
    />
  )
}
describe("Dispatcher Junction plan", () => {
  it("shows every Junction Line as a reviewable rail inside the plan", () => {
    const html = renderJunctionPlan()
    expect(html).toContain('aria-label="Junction Customer profile"')
    for (const name of [
      "Profile header",
      "Ticket history",
      "Connect profile",
      "Header",
      "History",
      "Route",
    ])
      expect(html).toContain(name)
    expect(html.match(/Converges at Junction/g)).toHaveLength(2)
    expect(html).toContain("Departs on release")
    expect(html).toContain("All four parts render together")
    expect(html).toContain(
      'aria-label="Unloading at Terminus for Connect profile"'
    )
    expect(html).toContain("Launch 3 Lines")
  })
})
