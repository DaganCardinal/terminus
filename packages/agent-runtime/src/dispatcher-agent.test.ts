import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { BaselineReport } from "@terminus/domain"
import {
  dispatchProposalSchema,
  planLimits,
  type PlanDraft,
  type PlanOutline,
  type PlanStation,
  type RoleExecution,
} from "@terminus/protocol"
import {
  HarnessDispatcher,
  dispatcherSystemPrompt,
  reviewProposalText,
  type DispatchSession,
  type DispatchSessionFactory,
} from "./dispatcher-agent"
import {
  emptyPlanDraft,
  planToolAgentName,
  planToolNames,
  planTools,
  planToolReply,
} from "./dispatch-draft"
import {
  FakeDispatchPlanner,
  type DispatchPlanningInput,
} from "./dispatch-planner"
import {
  DispatchProposalError,
  PlanToolFormatStalled,
  ProposalSubmissionsExhausted,
} from "./dispatch-proposal"
import { liveDispatcherProposal } from "./dispatcher.fixture"

const input: DispatchPlanningInput = {
  goal: "Add a footer",
  network: {
    projectChecks: [{ name: "test", command: ["npm", "test"] }],
    activeLines: [],
  },
  repository: { repoId: "n/terminus", commit: "a".repeat(40) },
  checkBaseline: false,
  validation: [{ name: "test", command: ["npm", "test"] }],
}

const failingBaseline: BaselineReport = {
  commit: "a".repeat(40),
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

/** Scripted final messages and saved drafts, one per run; records what the
 * Dispatcher sent. The last draft stays once the script runs out. */
function scripted(
  replies: (string | object)[],
  baseline: BaselineReport | null = null,
  drafts: PlanDraft[] = []
) {
  const text = (reply: string | object) =>
    typeof reply === "string" ? reply : JSON.stringify(reply)
  const queue = [...replies]
  const saved = [...drafts]
  const session = {
    restore: vi.fn<DispatchSession["restore"]>(async () => null),
    prepare: vi.fn<DispatchSession["prepare"]>(async () => baseline),
    start: vi.fn<DispatchSession["start"]>(async () =>
      text(queue.shift() ?? "")
    ),
    resume: vi.fn<DispatchSession["resume"]>(async () =>
      text(queue.shift() ?? "")
    ),
    draft: vi.fn<DispatchSession["draft"]>(async () =>
      saved.length > 1 ? saved.shift()! : (saved[0] ?? emptyPlanDraft)
    ),
    close: vi.fn<DispatchSession["close"]>(async () => {}),
  }
  const sessions: DispatchSessionFactory = { open: vi.fn(() => session) }
  return { session, sessions }
}

/** A proposal as a model may send it, before normalization. */
type Loose = {
  lines: {
    shared?: Record<string, unknown>
    stations: { manifest: Record<string, unknown> }[]
  }[]
  [field: string]: unknown
}

const valid = async () => (await new FakeDispatchPlanner().plan(input)).proposal

/** Claude Code has no plan tools, so it replies with the proposal JSON. */
const textModel = "anthropic/claude-haiku-4-5-20251001"
const textDispatcher = (sessions: DispatchSessionFactory) =>
  new HarnessDispatcher(textModel, sessions, {
    harness: "claude-code",
    model: textModel,
  } as RoleExecution)

const tool = (name: keyof typeof planToolNames) =>
  `\`${planToolAgentName(planToolNames[name])}\``

function station(key: string, fields: Partial<PlanStation> = {}): PlanStation {
  return {
    key,
    name: `Station ${key}`,
    goal: "Add a footer",
    changeKind: "implementation",
    changeDescription: "Add the footer component",
    scope: ["The footer only"],
    expectedAreas: [`src/${key}.tsx`],
    invariants: ["Existing pages are unchanged"],
    acceptanceCriteria: ["A footer renders on every page"],
    expectedEvidence: ["test"],
    ...fields,
  }
}
const outline: PlanOutline = {
  summary: "One Line adds the footer.",
  lines: [
    {
      key: "footer",
      name: "Footer",
      unloadRecommendation: { mode: "auto", reason: "A small change." },
      stations: ["footer", "footer-tests"],
    },
  ],
}
const draft = (...stations: PlanStation[]): PlanDraft => ({
  outline,
  stations: Object.fromEntries(stations.map((s) => [s.key, s])),
})
const complete = draft(station("footer"), station("footer-tests"))

describe("harness Dispatcher", () => {
  it("changes format after a stalled tool loop, keeping the native session and saved work", async () => {
    const { session, sessions } = scripted([], null, [
      draft(station("footer")),
      complete,
    ])
    session.start.mockRejectedValueOnce(new PlanToolFormatStalled())
    const result = await new HarnessDispatcher("configured", sessions).plan(
      input
    )
    expect(result.proposal.lines[0]!.stations).toHaveLength(2)
    expect(session.start).toHaveBeenCalledOnce()
    expect(session.resume).toHaveBeenCalledOnce()
    expect(session.resume.mock.calls[0]![0]).toContain(
      "send exactly one tool call at a time"
    )
    expect(session.resume.mock.calls[0]![0]).toContain(
      "send list fields as JSON strings"
    )
    expect(session.resume.mock.calls[0]![0]).toContain("`footer-tests`")
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("bounds format recovery to the existing two session corrections", async () => {
    const { session, sessions } = scripted([], null, [draft(station("footer"))])
    session.start.mockRejectedValue(new PlanToolFormatStalled())
    session.resume.mockRejectedValue(new PlanToolFormatStalled())
    await expect(
      new HarnessDispatcher("configured", sessions).plan(input)
    ).rejects.toBeInstanceOf(DispatchProposalError)
    expect(session.resume).toHaveBeenCalledTimes(2)
  })

  it("recovers a complete persisted draft without preparing or starting a Sandbox", async () => {
    const { session, sessions } = scripted([])
    session.restore.mockResolvedValue({ draft: complete, baseline: null })
    const result = await new HarnessDispatcher("configured", sessions).plan(
      input
    )
    expect(result.proposal.lines[0]!.stations).toHaveLength(2)
    expect(session.prepare).not.toHaveBeenCalled()
    expect(session.start).not.toHaveBeenCalled()
    expect(session.resume).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("gives a fresh session the saved pieces and remaining problems after an interruption", async () => {
    const { session, sessions } = scripted([""], null, [complete])
    const partial = draft(station("footer"))
    session.restore.mockResolvedValue({ draft: partial, baseline: null })
    const result = await new HarnessDispatcher("configured", sessions).plan(
      input
    )
    expect(result.proposal.lines[0]!.stations).toHaveLength(2)
    expect(session.start.mock.calls[0]![1]).toContain(JSON.stringify(partial))
    expect(session.start.mock.calls[0]![1]).toContain(
      "These Stations are in the outline but not saved: `footer-tests`"
    )
    expect(session.start.mock.calls[0]![1]).toContain("do not restart the plan")
    expect(session.resume).not.toHaveBeenCalled()
  })

  it("reassesses restored work against current planning context before reusing it", async () => {
    const { session, sessions } = scripted([""], null, [complete])
    session.restore.mockResolvedValue({ draft: complete, baseline: null })
    const result = await new HarnessDispatcher("configured", sessions).plan({
      ...input,
      network: { projectChecks: [], activeLines: [] },
    })
    expect(session.prepare).toHaveBeenCalledOnce()
    expect(session.start.mock.calls[0]![1]).toContain(
      "evidence test is not a configured project check"
    )
    expect(session.resume).toHaveBeenCalledTimes(2)
    expect(result.proposal.lines[0]!.stations).toHaveLength(2)
  })

  it("explores through one session and returns the saved plan without corrections", async () => {
    const { session, sessions } = scripted(["Plan submitted."], null, [
      complete,
    ])
    const result = await new HarnessDispatcher("configured", sessions).plan(
      input
    )
    expect(result.proposal.lines[0]!.stations.map((s) => s.key)).toEqual([
      "footer",
      "footer-tests",
    ])
    expect(dispatchProposalSchema.parse(result.proposal)).toEqual(
      result.proposal
    )
    expect(result.baseline).toBeNull()
    expect(sessions.open).toHaveBeenCalledWith({
      model: "configured",
      repository: input.repository,
      checkBaseline: false,
      validation: input.validation,
      network: input.network,
    })
    const [system, message] = session.start.mock.calls[0]!
    // OpenCode, the default harness, offers the plan tools.
    expect(system).toContain("## Writing the Plan")
    expect(system).toContain(tool("station"))
    expect(system).not.toContain("## Proposal JSON schema")
    // Without JSON-text outlines, the outline tool carries its own schema.
    expect(system).not.toContain("## Outline JSON schema")
    expect(message).toContain(`starting with ${tool("outline")}`)
    expect(system).toContain("untrusted context")
    expect(system).toContain("SAME canonical baseline")
    expect(system).toContain("ONLY plain paths")
    expect(system).toContain("read-only `explore` subagents")
    expect(system).toContain(
      "Otherwise use the available read/search tools directly"
    )
    // Evidence names come from the same project checks the plan is checked with.
    expect(system).toContain(
      '"validationNames":["test"],"projectChecks":[{"name":"test","command":["npm","test"]}]'
    )
    // The size limits the schemas enforce, stated where the model reads them.
    expect(system).toContain(`**${planLimits.lines} Lines**`)
    expect(system).toContain(
      `**${planLimits.stationsPerLine} Stations per Line**`
    )
    expect(system).toContain(`**${planLimits.stations} Stations total**`)
    expect(system).toContain(
      `Keep the combined plan to at most ${planLimits.stations} Stations.`
    )
    expect(message).toContain("Add a footer")
    expect(session.resume).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("asks GLM for the outline as JSON text and includes its schema", async () => {
    const model = "@cf/zai-org/glm-5.3-flash"
    const { session, sessions } = scripted([""], null, [complete])
    await new HarnessDispatcher(model, sessions).plan(input)
    const [system] = session.start.mock.calls[0]!
    expect(system).toContain("Pass the outline as JSON text")
    expect(system).toContain("## Outline JSON schema")
    expect(system).toContain(
      "arrays of strings or a string with one item per line"
    )
  })

  it.each([false, true])(
    "supplies the actual Station schema and a valid call example (outline as text: %s)",
    (outlineAsText) => {
      const system = dispatcherSystemPrompt({
        network: input.network,
        baseline: null,
        planTools: true,
        outlineAsText,
      })
      const schemaText = system
        .split("## Station tool input JSON schema\n\n")[1]!
        .split("\n\n")[0]!
      const schema = JSON.parse(schemaText) as Parameters<
        typeof z.fromJSONSchema
      >[0]
      expect(schema).toEqual(planTools(outlineAsText)[1]!.inputSchema)
      const exampleText = system.match(
        /### Station call example[\s\S]*?```json\n([\s\S]*?)\n```/
      )![1]!
      const example = JSON.parse(exampleText) as Record<string, unknown>
      expect(z.fromJSONSchema(schema).parse(example)).toEqual(example)
      const context = { network: input.network, baseline: null }
      const saved = planToolReply(
        planToolNames.station,
        example,
        emptyPlanDraft,
        context
      )
      expect(saved.outcome).toBe("saved")
      const textScope = JSON.parse(
        system.match(/scope can be sent as `([^`]+)`/)![1]!
      ) as Record<string, unknown>
      const alternate = { ...example, ...textScope }
      expect(z.fromJSONSchema(schema).parse(alternate)).toEqual(alternate)
      expect(
        planToolReply(planToolNames.station, alternate, emptyPlanDraft, context)
          .draft
      ).toEqual(saved.draft)
      expect(system).toContain(
        "do not nest fields under `manifest` or `station`"
      )
    }
  )

  it("corrects an incomplete draft in the same session", async () => {
    const { session, sessions } = scripted([""], null, [
      draft(station("footer")),
      complete,
    ])
    const result = await new HarnessDispatcher("configured", sessions).plan(
      input
    )
    expect(result.proposal.lines[0]!.stations).toHaveLength(2)
    expect(session.resume).toHaveBeenCalledOnce()
    const correction = session.resume.mock.calls[0]![0]
    expect(correction).toContain("Your saved plan is not complete:")
    expect(correction).toContain(
      "These Stations are in the outline but not saved: `footer-tests`."
    )
    expect(correction).toContain(`then call ${tool("finalize")}`)
  })

  it("saves a still-blocked draft after the last correction", async () => {
    const blocked = draft(
      station("footer"),
      station("footer-tests", { expectedEvidence: ["lint"] })
    )
    const { session, sessions } = scripted([""], null, [blocked])
    const result = await new HarnessDispatcher("configured", sessions).plan(
      input
    )
    expect(session.resume).toHaveBeenCalledTimes(2)
    expect(session.resume.mock.calls[0]![0]).toContain(
      "- Station `footer-tests`: Footer / Station footer-tests: evidence lint is not a configured project check."
    )
    expect(
      result.proposal.lines[0]!.stations[1]!.manifest.expectedEvidence
    ).toEqual(["lint"])
  })

  it("fails safely when nothing was saved", async () => {
    const { session, sessions } = scripted([""])
    const error = await new HarnessDispatcher("configured", sessions)
      .plan(input)
      .catch((error: unknown) => error)
    expect(session.resume).toHaveBeenCalledTimes(2)
    expect(error).toBeInstanceOf(DispatchProposalError)
    expect((error as DispatchProposalError).issues).toEqual([
      { path: "$", code: "missing_outline" },
    ])
  })

  it("accepts a fenced final message", async () => {
    const proposal = await valid()
    const { sessions } = scripted([
      "```json\n" + JSON.stringify(proposal) + "\n```",
    ])
    expect((await textDispatcher(sessions).plan(input)).proposal).toEqual(
      proposal
    )
  })

  it("corrects verification-only Stations inside the same session", async () => {
    const proposal = await valid()
    const invalid = JSON.parse(JSON.stringify(proposal)) as typeof proposal
    invalid.lines[0]!.stations[0]!.manifest.repositoryChange = {
      kind: "verification" as "tests",
      description: "Run existing tests",
    }
    const { session, sessions } = scripted([invalid, proposal])
    expect((await textDispatcher(sessions).plan(input)).proposal).toEqual(
      proposal
    )
    expect(session.resume).toHaveBeenCalledOnce()
    expect(session.resume.mock.calls[0]![0]).toContain(
      '"path":"lines.0.stations.0.manifest.repositoryChange.kind","code":"invalid_value"'
    )
  })

  it("feeds assessment problems back and saves a still-blocked proposal after the last correction", async () => {
    const proposal = await valid()
    const blocked = JSON.parse(JSON.stringify(proposal)) as typeof proposal
    blocked.lines[0]!.stations[0]!.manifest.expectedEvidence = ["lint"]
    const { session, sessions } = scripted([blocked, blocked, blocked])
    const result = await textDispatcher(sessions).plan(input)
    expect(result.proposal).toEqual(blocked)
    expect(session.resume).toHaveBeenCalledTimes(2)
    expect(session.resume.mock.calls[0]![0]).toContain(
      "evidence lint is not a configured project check"
    )
    expect(session.resume.mock.calls[0]![0]).toContain(
      "Reply with the complete corrected proposal JSON as your final message."
    )
  })

  it("asks for the proposal as the final message when the harness has no plan tools", async () => {
    const proposal = await valid()
    const blocked = JSON.parse(JSON.stringify(proposal)) as typeof proposal
    blocked.lines[0]!.stations[0]!.manifest.expectedEvidence = ["lint"]
    const { session, sessions } = scripted([blocked, proposal])
    await textDispatcher(sessions).plan(input)
    const [system, message] = session.start.mock.calls[0]!
    expect(system).not.toContain("## Writing the Plan")
    expect(system).toContain("## Final Message")
    expect(system).toContain("## Proposal JSON schema")
    expect(message).toContain("reply with only the proposal JSON")
    expect(session.resume.mock.calls[0]![0]).toContain(
      "Reply with the complete corrected proposal JSON as your final message."
    )
    expect(session.draft).not.toHaveBeenCalled()
  })

  it("accepts omissions that cannot change the plan instead of asking for a resubmission", async () => {
    const proposal = await valid()
    // The live rejection: a Manifest without `dependencies` and a null `baselineFix`.
    const loose = structuredClone(proposal) as unknown as Loose
    delete loose.lines[0]!.stations[0]!.manifest.dependencies
    delete loose.lines[0]!.stations[0]!.manifest.avoidAreas
    loose.baselineFix = null
    loose.findings = null
    const { session, sessions } = scripted([loose])
    const result = await textDispatcher(sessions).plan(input)
    expect(session.resume).not.toHaveBeenCalled()
    expect(result.proposal.lines[0]!.stations[0]!.manifest).toMatchObject({
      dependencies: [],
      avoidAreas: [],
    })
    expect(result.proposal).not.toHaveProperty("baselineFix")

    // Anything with meaning is still the schema's to judge.
    const wrong = structuredClone(proposal) as unknown as Loose
    wrong.lines[0]!.stations[0]!.manifest.dependencies = "none"
    expect(
      reviewProposalText(JSON.stringify(wrong), input.network, null).kind
    ).toBe("schema")
  })

  it("expands Line-shared Manifest values into every Station and stores none", async () => {
    const proposal = await valid()
    const loose = structuredClone(proposal) as unknown as Loose
    const line = loose.lines[0]!
    const first = line.stations[0]!
    const second = structuredClone(first) as typeof first & { key: string }
    second.key = "second-station"
    second.manifest.dependencies = []
    line.stations.push(second)
    line.shared = {
      invariants: ["Everything stays client-side and in memory."],
      expectedEvidence: ["test"],
      avoidAreas: ["server/"],
      projectFacts: ["vite.config.ts runs Vitest in jsdom."],
    }
    delete first.manifest.invariants
    first.manifest.expectedEvidence = ["test"]
    second.manifest.invariants = ["The footer keeps its landmark role."]
    delete second.manifest.expectedEvidence
    delete second.manifest.projectFacts

    const { session, sessions } = scripted([loose])
    const result = await textDispatcher(sessions).plan(input)
    expect(session.resume).not.toHaveBeenCalled()
    expect(result.proposal.lines[0]).not.toHaveProperty("shared")
    const [one, two] = result.proposal.lines[0]!.stations
    expect(one!.manifest).toMatchObject({
      invariants: ["Everything stays client-side and in memory."],
      // A value both the Line and the Station state is kept once.
      expectedEvidence: ["test"],
      avoidAreas: [
        "server/",
        ...proposal.lines[0]!.stations[0]!.manifest.avoidAreas,
      ],
    })
    expect(one!.manifest.projectFacts?.[0]).toBe(
      "vite.config.ts runs Vitest in jsdom."
    )
    expect(two!.manifest).toMatchObject({
      invariants: [
        "Everything stays client-side and in memory.",
        "The footer keeps its landmark role.",
      ],
      expectedEvidence: ["test"],
      projectFacts: ["vite.config.ts runs Vitest in jsdom."],
    })
    expect(dispatchProposalSchema.safeParse(result.proposal).success).toBe(true)

    // Every Station still needs an invariant once shared values are merged.
    const missing = structuredClone(loose)
    delete missing.lines[0]!.shared!.invariants
    expect(
      reviewProposalText(JSON.stringify(missing), input.network, null)
    ).toMatchObject({
      kind: "schema",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "lines.0.stations.0.manifest.invariants",
        }),
      ]),
    })
  })

  it("repairs the live path-field failure with exact validation feedback", async () => {
    const result = dispatchProposalSchema.safeParse(liveDispatcherProposal)
    expect(result.success).toBe(false)
    const corrected = JSON.parse(
      JSON.stringify(liveDispatcherProposal)
    ) as typeof liveDispatcherProposal
    Object.assign(corrected.lines[0]!, {
      unloadRecommendation: {
        mode: "human_approval",
        reason: "Preview the visual theme change.",
      },
    })
    const work = corrected.lines[0]!.stations[0]!.manifest
    Object.assign(work, {
      repositoryChange: {
        kind: "configuration",
        description: "Update the primary theme tokens",
      },
    })
    work.expectedAreas[1] = "src/components/ui/button.tsx"
    work.avoidAreas.pop()
    const { session, sessions } = scripted([liveDispatcherProposal, corrected])
    const goal = {
      ...input,
      goal: "Change the primary accent colour to #32a852",
      network: {
        ...input.network,
        projectChecks: [
          { name: "build", command: ["npm", "run", "build"] },
          { name: "test", command: ["npm", "test"] },
        ],
      },
    }
    expect((await textDispatcher(sessions).plan(goal)).proposal).toEqual(
      corrected
    )
    const feedback = session.resume.mock.calls[0]![0]
    expect(feedback).toContain(
      '{"path":"lines.0.stations.0.manifest.expectedAreas.1","code":"invalid_format"}'
    )
    expect(feedback).toContain(
      '{"path":"lines.0.stations.0.manifest.avoidAreas.6","code":"invalid_format"}'
    )
  })

  it("bounds corrections and exposes field codes without raw values or unknown keys", async () => {
    const invalid = {
      ...liveDispatcherProposal,
      "private-response-text": "secret",
    }
    const { session, sessions } = scripted([invalid, invalid, invalid])
    const error = await textDispatcher(sessions)
      .plan(input)
      .catch((error: unknown) => error)
    expect(session.start).toHaveBeenCalledOnce()
    expect(session.resume).toHaveBeenCalledTimes(2)
    expect(session.close).toHaveBeenCalledOnce()
    expect(error).toBeInstanceOf(DispatchProposalError)
    if (!(error instanceof DispatchProposalError))
      throw new Error("Expected safe validation error")
    expect(error.message).toContain("expectedAreas.1 (invalid_format)")
    expect(error.message).not.toContain("private-response-text")
    expect(error.message).not.toContain("secret")
    expect(error.issues).toContainEqual({
      path: "$",
      code: "unrecognized_keys",
    })
  })

  it("makes the saved draft final once the harness stops after repeated rejections", async () => {
    const { session, sessions } = scripted([], null, [draft(station("footer"))])
    session.start.mockRejectedValueOnce(
      new ProposalSubmissionsExhausted("Stopped.")
    )
    const error = await new HarnessDispatcher("configured", sessions)
      .plan(input)
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(DispatchProposalError)
    expect(session.resume).not.toHaveBeenCalled()
    expect((error as Error).message).toBe(
      "Dispatcher proposal failed validation after repeated rejected plan tool calls: stations (missing_station)"
    )
    expect(session.close).toHaveBeenCalledOnce()

    // A still-blocked plan is saved, as after the last correction.
    const blocked = draft(
      station("footer"),
      station("footer-tests", { expectedEvidence: ["lint"] })
    )
    const later = scripted([""], null, [draft(station("footer")), blocked])
    later.session.resume.mockRejectedValueOnce(
      new ProposalSubmissionsExhausted("Stopped.")
    )
    const result = await new HarnessDispatcher(
      "configured",
      later.sessions
    ).plan(input)
    expect(later.session.resume).toHaveBeenCalledOnce()
    expect(
      result.proposal.lines[0]!.stations[1]!.manifest.expectedEvidence
    ).toEqual(["lint"])
  })

  it("treats a final message without JSON as a schema problem", async () => {
    const proposal = await valid()
    const { session, sessions } = scripted(["I explored the repo.", proposal])
    await textDispatcher(sessions).plan(input)
    expect(session.resume.mock.calls[0]![0]).toContain(
      '{"path":"$","code":"invalid_json"}'
    )
  })

  it("restores a Station closer the model skipped without spending a correction", async () => {
    const proposal = await valid()
    const [line, ...rest] = proposal.lines
    // The live failure: `}]` where `}}]` closes the last Station's manifest and the Station.
    const stations = JSON.stringify(line!.stations).replace(/}\]$/, "]")
    const text = JSON.stringify({
      ...proposal,
      lines: [{ ...line, stations: "STATIONS" }, ...rest],
    }).replace('"STATIONS"', stations)
    const { session, sessions } = scripted([text])
    expect((await textDispatcher(sessions).plan(input)).proposal).toEqual(
      proposal
    )
    expect(session.resume).not.toHaveBeenCalled()
  })

  it("tells the model where its JSON fails but keeps the parser out of the error", async () => {
    const broken = '{"summary":"x" oops}'
    const { session, sessions } = scripted([broken, broken, broken])
    const error = await textDispatcher(sessions)
      .plan(input)
      .catch((error: unknown) => error)
    const feedback = session.resume.mock.calls[0]![0]
    expect(feedback).toContain('{"path":"$","code":"invalid_json"}')
    expect(feedback).toContain("The parser reported:")
    expect(feedback).toContain("position 15")
    expect(error).toBeInstanceOf(DispatchProposalError)
    if (!(error instanceof Error)) throw new Error("Expected an error")
    expect(error.message).toBe(
      "Dispatcher proposal failed validation after three attempts: $ (invalid_json)"
    )
  })

  it("shows where a rejected proposal's JSON stopped parsing", async () => {
    const proposal = await valid()
    const [line] = proposal.lines
    // The live failure: every `scope` list closed with `}`. With routed Lines
    // after the Stations, neither repair recovers the plan, and the model was
    // told only a character position.
    const routed = (key: string) => ({
      ...line,
      key,
      route: line!.stations.map((station) => ({
        kind: "station",
        key: station.key,
      })),
    })
    const text = JSON.stringify({
      ...proposal,
      lines: [routed("first"), routed("second")],
    }).replace(/("scope":\[(?:"[^"]*",?)*)\]/g, "$1}")
    const review = reviewProposalText(text, input.network, null)
    expect(review).toMatchObject({
      kind: "schema",
      issues: [{ path: "$", code: "invalid_json" }],
    })
    const hint = review.kind === "schema" ? (review.parseHint ?? "") : ""
    expect(hint).toMatch(/"<<<HERE>>>},"expectedAreas"/)
    expect(hint).toContain(
      "There, the `scope` array is still open, and `}` cannot close it: it closes with `]`."
    )
  })

  it("supplies a trusted baseline report and keeps a baseline fix only when checks failed", async () => {
    const proposal = (
      await new FakeDispatchPlanner().plan({ ...input, checkBaseline: true })
    ).proposal
    const failing = scripted([proposal], failingBaseline)
    const result = await textDispatcher(failing.sessions).plan({
      ...input,
      checkBaseline: true,
    })
    expect(result.baseline).toEqual(failingBaseline)
    expect(result.proposal.baselineFix?.line.stations).toHaveLength(1)
    expect(failing.session.start.mock.calls[0]![0]).toContain(
      '"baseline":{"commit"'
    )
    const passing = scripted([proposal, await valid()], {
      ...failingBaseline,
      checks: [{ ...failingBaseline.checks[0]!, status: "passed" }],
    })
    expect(
      (await textDispatcher(passing.sessions).plan(input)).proposal.baselineFix
    ).toBeUndefined()
    expect(passing.session.resume.mock.calls[0]![0]).toContain(
      "baseline checks did not fail"
    )
  })

  it("closes the session and leaves transient failures to the durable execution layer", async () => {
    const { session, sessions } = scripted([])
    session.start.mockRejectedValueOnce(new Error("429"))
    await expect(textDispatcher(sessions).plan(input)).rejects.toThrow("429")
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("keeps a finished plan, or why planning failed, when cleanup fails", async () => {
    const finished = scripted([""], null, [complete])
    finished.session.close.mockRejectedValueOnce(new Error("cleanup"))
    const result = await new HarnessDispatcher(
      "configured",
      finished.sessions
    ).plan(input)
    expect(result.proposal.lines[0]!.stations).toHaveLength(2)

    const failed = scripted([""])
    failed.session.close.mockRejectedValueOnce(new Error("cleanup"))
    await expect(
      new HarnessDispatcher("configured", failed.sessions).plan(input)
    ).rejects.toBeInstanceOf(DispatchProposalError)
  })

  it("keeps a complete saved plan when the harness fails after writing it", async () => {
    const { session, sessions } = scripted([], null, [complete])
    session.start.mockRejectedValueOnce(new Error("OpenCode exited with 137"))
    const result = await new HarnessDispatcher("configured", sessions).plan(
      input
    )
    expect(result.proposal.lines[0]!.stations).toHaveLength(2)
    expect(session.resume).not.toHaveBeenCalled()

    // The same holds for a correction that completes the plan, then fails.
    const corrected = scripted([""], null, [draft(station("footer")), complete])
    corrected.session.resume.mockRejectedValueOnce(new Error("timed out"))
    expect(
      (
        await new HarnessDispatcher("configured", corrected.sessions).plan(
          input
        )
      ).proposal.lines[0]!.stations
    ).toHaveLength(2)
  })

  it("leaves a harness failure to the durable retry unless the saved plan is valid", async () => {
    const incomplete = scripted([], null, [draft(station("footer"))])
    incomplete.session.start.mockRejectedValueOnce(new Error("timed out"))
    await expect(
      new HarnessDispatcher("configured", incomplete.sessions).plan(input)
    ).rejects.toThrow("timed out")
    expect(incomplete.session.resume).not.toHaveBeenCalled()

    const blocked = scripted([], null, [
      draft(
        station("footer"),
        station("footer-tests", { expectedEvidence: ["lint"] })
      ),
    ])
    blocked.session.start.mockRejectedValueOnce(new Error("timed out"))
    await expect(
      new HarnessDispatcher("configured", blocked.sessions).plan(input)
    ).rejects.toThrow("timed out")

    const unreadable = scripted([], null, [complete])
    unreadable.session.start.mockRejectedValueOnce(new Error("timed out"))
    unreadable.session.draft.mockRejectedValueOnce(new Error("D1"))
    await expect(
      new HarnessDispatcher("configured", unreadable.sessions).plan(input)
    ).rejects.toThrow("timed out")
  })

  it("makes fake execution explicit and supports the bounded goal input", async () => {
    const planner = new FakeDispatchPlanner()
    expect(planner.model).toBe("fake")
    const { proposal, baseline } = await planner.plan({
      ...input,
      goal: "a".repeat(4000),
    })
    expect(baseline).toBeNull()
    const result = dispatchProposalSchema.parse(proposal)
    expect(result.summary).toContain("Simulated")
    expect(result.lines[0]!.stations[0]!.manifest.expectedEvidence).toEqual([
      "test",
    ])
    const checked = await planner.plan({ ...input, checkBaseline: true })
    expect(checked.baseline?.checks.some((c) => c.status === "failed")).toBe(
      true
    )
    expect(
      dispatchProposalSchema.parse(checked.proposal).baselineFix
    ).toBeDefined()
  })
})
