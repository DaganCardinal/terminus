import { describe, expect, it } from "vitest"
import {
  assessDispatchProposal,
  createDispatchPlan,
  failDispatchPlan,
  finishPlanLaunch,
  launchDispatchPlan,
  readyDispatchPlan,
  requestPlanLaunch,
  type DispatchProposal,
} from "./dispatch-plan"
import { manifest, unwrap, expectRejected, eventTypes } from "./testing"

const context = { validationNames: ["test"], activeLines: [] }
const proposal = (): DispatchProposal => ({
  summary: "Implement the goal",
  lines: [
    {
      key: "red",
      name: "Red Line",
      stations: [
        {
          key: "footer",
          name: "Footer",
          manifest: manifest({ expectedAreas: ["src/footer.tsx"] }),
        },
        {
          key: "tests",
          name: "Tests",
          manifest: manifest({
            expectedAreas: ["src/footer.test.tsx"],
            dependencies: ["footer"],
          }),
        },
      ],
    },
  ],
})
const plan = () =>
  unwrap(
    createDispatchPlan({
      id: "plan",
      networkId: "net",
      goal: "Add footer",
      model: "configured",
      terminusCommit: "base",
      createdAt: "now",
    })
  )
const ready = () => unwrap(readyDispatchPlan(plan(), proposal(), context))

describe("Dispatcher plan lifecycle", () => {
  it("refuses launch of a plan without concrete changes", () => {
    for (const repositoryChange of [
      undefined,
      { kind: "verification" as const, description: "Confirm earlier work" },
    ]) {
      const p = proposal()
      p.lines[0]!.stations[0]!.manifest.repositoryChange = repositoryChange
      expect(assessDispatchProposal(p, context).errors.join(" ")).toContain(
        "concrete repository change"
      )
      expectRejected(
        requestPlanLaunch(
          unwrap(readyDispatchPlan(plan(), p, context)),
          "base",
          context
        ),
        "invalid_input"
      )
    }
  })
  it("records request, reviewable proposal, explicit launch and completed kickoff separately", () => {
    expect(eventTypes(createDispatchPlan(plan()))).toEqual([
      "dispatcher.plan_requested",
    ])
    const prepared = readyDispatchPlan(plan(), proposal(), context)
    expect(eventTypes(prepared)).toEqual(["dispatcher.plan_ready"])
    const requested = requestPlanLaunch(unwrap(prepared), "base", context)
    expect(eventTypes(requested)).toEqual(["dispatcher.launch_requested"])
    const started = launchDispatchPlan(unwrap(requested), ["line"], ["train"])
    expect(unwrap(started).state.status).toBe("starting")
    expect(eventTypes(started)).toEqual(["dispatcher.lines_laid"])
    const finished = finishPlanLaunch(unwrap(started))
    expect(unwrap(finished).state.status).toBe("launched")
    expect(eventTypes(finished)).toEqual(["dispatcher.plan_launched"])
  })
  it("rejects out-of-order moves, missing Trains and stale canonical state", () => {
    expectRejected(
      createDispatchPlan({ ...plan(), goal: " " }),
      "invalid_input"
    )
    expectRejected(requestPlanLaunch(plan(), "base", context), "invalid_state")
    expectRejected(
      readyDispatchPlan(ready(), proposal(), context),
      "invalid_state"
    )
    expectRejected(
      requestPlanLaunch(ready(), "new-head", context),
      "invalid_input"
    )
    expectRejected(
      launchDispatchPlan(ready(), ["line"], ["train"]),
      "invalid_state"
    )
    expectRejected(finishPlanLaunch(ready()), "invalid_state")
    const requested = unwrap(requestPlanLaunch(ready(), "base", context))
    expectRejected(launchDispatchPlan(requested, [], []), "invalid_input")
  })
  it("records failures without discarding already laid topology", () => {
    expect(eventTypes(failDispatchPlan(plan(), "Unavailable"))).toEqual([
      "dispatcher.plan_failed",
    ])
    const requested = unwrap(requestPlanLaunch(ready(), "base", context))
    expect(unwrap(failDispatchPlan(requested, "Moved")).state.status).toBe(
      "failed"
    )
    expectRejected(failDispatchPlan(ready(), "Unavailable"), "invalid_state")
    const started = unwrap(launchDispatchPlan(requested, ["line"], ["train"]))
    expectRejected(failDispatchPlan(started, "Unavailable"), "invalid_state")
  })
})

describe("deterministic plan assessment", () => {
  it("permits dependent work in order on one Line", () => {
    expect(assessDispatchProposal(proposal(), context)).toEqual({
      errors: [],
      collisions: [],
    })
  })
  it("rejects duplicate keys, unknown evidence, unknown or forward dependencies and avoided areas", () => {
    const p = proposal()
    p.lines[0]!.stations[0]!.manifest.dependencies = ["tests", "missing"]
    p.lines[0]!.stations[0]!.manifest.expectedEvidence = ["invented"]
    p.lines[0]!.stations[0]!.manifest.avoidAreas = ["src/"]
    p.lines.push({
      ...p.lines[0]!,
      stations: p.lines[0]!.stations.map((station) => ({ ...station })),
    })
    const { errors } = assessDispatchProposal(p, context)
    expect(errors.join(" ")).toMatch(/Duplicate Line key/)
    expect(errors.join(" ")).toMatch(/Duplicate Station key/)
    expect(errors.join(" ")).toMatch(/earlier Station/)
    expect(errors.join(" ")).toMatch(/unknown key/)
    expect(errors.join(" ")).toMatch(/configured project check/)
    expect(errors.join(" ")).toMatch(/avoided area/)
    const invalid = unwrap(readyDispatchPlan(plan(), p, context))
    expectRejected(requestPlanLaunch(invalid, "base", context), "invalid_input")
  })
  it("rejects explicit or contract-based code dependencies across Lines", () => {
    const p = proposal()
    const testStation = p.lines[0]!.stations.pop()!
    p.lines.push({ key: "blue", name: "Blue Line", stations: [testStation] })
    expect(assessDispatchProposal(p, context).errors.join(" ")).toMatch(
      /same Line/
    )
    testStation.manifest.dependencies = []
    testStation.manifest.contracts = [
      { name: "Footer", kind: "symbol", change: "depends_on" },
    ]
    p.lines[0]!.stations[0]!.manifest.contracts = [
      { name: "Footer", kind: "symbol", change: "adds" },
    ]
    expect(assessDispatchProposal(p, context).errors.join(" ")).toMatch(
      /code dependency/
    )
  })
  it("forecasts shared files/directories and mutating contracts without inventing Git conflicts", () => {
    const p = proposal()
    p.lines[0]!.stations[0]!.manifest.contracts = [
      { name: "Footer", kind: "symbol", change: "changes" },
    ]
    const activeLines = [
      {
        name: "Active",
        manifests: [
          manifest({
            expectedAreas: ["src"],
            contracts: [{ name: "Footer", kind: "symbol", change: "adds" }],
          }),
        ],
      },
    ]
    const result = assessDispatchProposal(p, { ...context, activeLines })
    expect(result.errors).toEqual([])
    expect(result.collisions[0]).toMatchObject({
      line: "Red Line",
      otherLine: "Active",
      contracts: ["symbol: Footer"],
    })
    expectRejected(
      requestPlanLaunch(ready(), "base", { ...context, activeLines }),
      "invalid_input"
    )
    const reviewed = unwrap(
      readyDispatchPlan(plan(), p, { ...context, activeLines })
    )
    expect(
      requestPlanLaunch(reviewed, "base", { ...context, activeLines }).ok
    ).toBe(true)
    expect(
      assessDispatchProposal(p, {
        ...context,
        activeLines: [
          {
            name: "Other",
            manifests: [manifest({ expectedAreas: ["src-other/"] })],
          },
        ],
      }).collisions
    ).toEqual([])
  })
})

it("permits a cross-Line contract consumer only after pickup includes its provider", () => {
  const p = proposal()
  const consumer = p.lines[0]!.stations.pop()!
  consumer.manifest.contracts = [
    { name: "Footer", kind: "symbol", change: "depends_on" },
  ]
  p.lines[0]!.stations[0]!.manifest.contracts = [
    { name: "Footer", kind: "symbol", change: "adds" },
  ]
  p.lines.push({
    key: "blue",
    name: "Blue Line",
    stations: [consumer],
    route: [
      { kind: "crossing", source: { kind: "planned", stationKey: "footer" } },
      { kind: "station", key: consumer.key },
    ],
  })
  expect(assessDispatchProposal(p, context).errors).toEqual([])
  p.lines[1]!.route!.reverse()
  expect(assessDispatchProposal(p, context).errors.join(" ")).toMatch(
    /code dependency/
  )
})
