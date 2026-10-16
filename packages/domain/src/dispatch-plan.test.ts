import { describe, expect, it } from "vitest"
import {
  assessDispatchProposal,
  createDispatchPlan,
  cancelDispatchPlan,
  finishDispatchCancellation,
  failDispatchPlan,
  finishPlanLaunch,
  launchDispatchPlan,
  readyDispatchPlan,
  requestPlanLaunch,
  assessPlan,
  launchProposal,
  selectBaselineFix,
  selectPlannedUnloadMode,
  revisablePlan,
  supersedeDispatchPlan,
  type BaselineReport,
  type DispatchProposal,
} from "./dispatch-plan"
import { manifest, unwrap, expectRejected, eventTypes } from "./testing"

const context = {
  projectChecks: [{ name: "test", command: ["npm", "test"] }],
  activeLines: [],
}
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
  it("cancels planning once and refuses to cancel ready or launching work", () => {
    const stopped = cancelDispatchPlan(plan())
    expect(eventTypes(stopped)).toEqual(["dispatcher.plan_cancelled"])
    const cancelled = unwrap(stopped)
    expect(cancelled.state).toMatchObject({
      status: "failed",
      reason: "cancelled",
    })
    expect(eventTypes(cancelDispatchPlan(cancelled))).toEqual([])
    expectRejected(
      readyDispatchPlan(cancelled, proposal(), context),
      "invalid_state"
    )
    expectRejected(
      requestPlanLaunch(cancelled, "base", context),
      "invalid_state"
    )
    expectRejected(cancelDispatchPlan(ready()), "invalid_state")
    expectRejected(
      cancelDispatchPlan(unwrap(requestPlanLaunch(ready(), "base", context))),
      "invalid_state"
    )
  })
  it("records completion of cancellation cleanup once and requires a cancelled plan", () => {
    const stopped = unwrap(cancelDispatchPlan(plan()))
    expect(stopped.state).toMatchObject({ cleanupPending: true })
    const finished = finishDispatchCancellation(stopped)
    expect(eventTypes(finished)).toEqual(["dispatcher.plan_stopped"])
    expect(unwrap(finished).state).toMatchObject({ cleanupPending: false })
    expect(eventTypes(finishDispatchCancellation(unwrap(finished)))).toEqual([])
    expectRejected(finishDispatchCancellation(plan()), "invalid_state")
    expectRejected(
      finishDispatchCancellation(unwrap(failDispatchPlan(plan(), "Failed"))),
      "invalid_state"
    )
  })

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

describe("Baseline fix suggestions", () => {
  const failing: BaselineReport = {
    commit: "base",
    checks: [
      {
        name: "test",
        status: "failed",
        exitCode: 1,
        outputTail: "1 failing",
        outputTruncated: false,
      },
    ],
  }
  const withFix = (): DispatchProposal => ({
    ...proposal(),
    lines: [
      ...proposal().lines,
      {
        key: "blue",
        name: "Blue Line",
        route: [{ kind: "station", key: "header" }],
        stations: [
          {
            key: "header",
            name: "Header",
            manifest: manifest({ expectedAreas: ["src/header.tsx"] }),
          },
        ],
      },
    ],
    baselineFix: {
      reason: "The test check fails on the baseline",
      line: {
        key: "fix",
        name: "Baseline Fix",
        stations: [
          {
            key: "fix-tests",
            name: "Fix tests",
            manifest: manifest({ expectedAreas: ["src/broken.test.tsx"] }),
          },
        ],
      },
    },
  })
  const fixReady = () =>
    unwrap(readyDispatchPlan(plan(), withFix(), context, failing))

  it("routes every other Line through the accepted fix when included", () => {
    const launched = launchProposal(withFix())
    expect(launched.baselineFix).toBeUndefined()
    expect(launched.lines.map((l) => l.key)).toEqual(["fix", "red", "blue"])
    const pickup = {
      kind: "crossing",
      source: { kind: "planned", stationKey: "fix-tests" },
    }
    expect(launched.lines[1]!.route).toEqual([
      pickup,
      { kind: "station", key: "footer" },
      { kind: "station", key: "tests" },
    ])
    expect(launched.lines[2]!.route).toEqual([
      pickup,
      { kind: "station", key: "header" },
    ])
    expect(fixReady().state).toMatchObject({
      status: "ready",
      baseline: failing,
      assessment: { errors: [] },
    })
  })

  it("drops the fix when rejected and re-assesses the selection", () => {
    const rejected = selectBaselineFix(fixReady(), "reject", context)
    expect(eventTypes(rejected)).toEqual(["dispatcher.baseline_fix_selected"])
    const value = unwrap(rejected)
    if (value.state.status !== "ready") throw new Error("Expected ready")
    expect(
      launchProposal(value.state.proposal).lines.map((l) => l.key)
    ).toEqual(["red", "blue"])
    expect(eventTypes(selectBaselineFix(value, "reject", context))).toEqual([])
    expectRejected(
      selectBaselineFix(ready(), "include", context),
      "invalid_input"
    )
  })

  it("launches the fix Line with one Train", () => {
    const requested = unwrap(requestPlanLaunch(fixReady(), "base", context))
    expect(
      launchDispatchPlan(requested, ["l0", "l1", "l2"], ["t0", "t1", "t2"]).ok
    ).toBe(true)
    expectRejected(
      launchDispatchPlan(requested, ["l0", "l1"], ["t0", "t1"]),
      "invalid_input"
    )
  })

  it("refuses a fix without a failing baseline, and an included fix alongside Junctions", () => {
    expect(assessPlan(withFix(), context, undefined).errors).toContain(
      "A baseline fix was proposed, but the baseline checks did not fail."
    )
    const junctions: DispatchProposal = {
      ...withFix(),
      junctions: [
        {
          key: "feature",
          name: "Feature",
          brief: { validation: [] } as never,
          incoming: [],
          outgoing: { name: "Out", stations: [] },
        },
      ],
    }
    expect(assessPlan(junctions, context, failing).errors.join(" ")).toContain(
      "cannot reach Junction input Lines"
    )
  })

  it("refuses a Junction feature check that redefines a project check", () => {
    const line = proposal().lines[0]!
    const feature = (command: string[]): DispatchProposal => ({
      summary: "Feature",
      lines: [],
      junctions: [
        {
          key: "feature",
          name: "Feature",
          brief: {
            validation: [{ name: "test", command }],
          } as never,
          incoming: [
            { ...line, stations: [{ ...line.stations[0]!, key: "a" }] },
            { ...line, stations: [{ ...line.stations[0]!, key: "b" }] },
          ],
          outgoing: { name: "Out", stations: [] },
        },
      ],
    })
    const checks = {
      ...context,
      projectChecks: [{ name: "test", command: ["npm", "test"] }],
    }
    expect(
      assessPlan(
        feature(["npm", "run", "test"]),
        checks,
        undefined
      ).errors.join(" ")
    ).toContain("feature check test conflicts with the project check")
    expect(
      assessPlan(feature(["npm", "test"]), checks, undefined).errors.join(" ")
    ).not.toContain("conflicts with the project check")
  })

  it("selects the fix Line's unload mode like any other planned Line", () => {
    const selected = unwrap(
      selectPlannedUnloadMode(fixReady(), "fix", "human_approval")
    )
    if (selected.state.status !== "ready") throw new Error("Expected ready")
    expect(selected.state.proposal.baselineFix?.line.unloadMode).toBe(
      "human_approval"
    )
  })
})

describe("Plan revisions", () => {
  const inConversation = <T extends { conversationId?: string }>(p: T) => ({
    ...p,
    conversationId: "c1",
  })

  it("supersedes a ready plan so it can never launch, keeping its proposal", () => {
    const revised = supersedeDispatchPlan(inConversation(ready()), "plan-2")
    expect(eventTypes(revised)).toEqual(["dispatcher.plan_superseded"])
    const superseded = unwrap(revised)
    expect(superseded.state).toMatchObject({
      status: "failed",
      reason: "superseded",
      supersededBy: "plan-2",
      proposal: proposal(),
    })
    expectRejected(
      requestPlanLaunch(superseded, "base", context),
      "invalid_state"
    )
    expectRejected(supersedeDispatchPlan(superseded, "plan-3"), "invalid_state")
    expectRejected(supersedeDispatchPlan(plan(), "plan-3"), "invalid_state")
  })

  it("revises only this conversation's ready or failed plans", () => {
    const readyPlan = inConversation(ready())
    expect(revisablePlan(readyPlan, "c1").ok).toBe(true)
    expectRejected(revisablePlan(readyPlan, "c2"), "invalid_input")
    expectRejected(revisablePlan(ready(), "c1"), "invalid_input")
    const failed = inConversation(unwrap(failDispatchPlan(plan(), "broken")))
    expect(revisablePlan(failed, "c1").ok).toBe(true)
    const stopped = inConversation(unwrap(cancelDispatchPlan(plan())))
    expect(revisablePlan(stopped, "c1").ok).toBe(true)
    expectRejected(revisablePlan(inConversation(plan()), "c1"), "invalid_state")
    const launching = inConversation(
      unwrap(requestPlanLaunch(ready(), "base", context))
    )
    expectRejected(revisablePlan(launching, "c1"), "invalid_state")
    const superseded = inConversation(
      unwrap(supersedeDispatchPlan(readyPlan, "plan-2"))
    )
    expectRejected(revisablePlan(superseded, "c1"), "invalid_state")
  })
})
