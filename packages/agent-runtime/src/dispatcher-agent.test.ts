import { describe, expect, it, vi } from "vitest"
import type { BaselineReport } from "@terminus/domain"
import { dispatchProposalSchema } from "@terminus/protocol"
import type { RoleExecution } from "@terminus/protocol"
import {
  HarnessDispatcher,
  proposalSubmissionReply,
  type DispatchSession,
  type DispatchSessionFactory,
} from "./dispatcher-agent"
import { proposalAcceptedReply, proposalToolAgentName } from "./opencode"
import {
  FakeDispatchPlanner,
  type DispatchPlanningInput,
} from "./dispatch-planner"
import {
  DispatchProposalError,
  ProposalSubmissionsExhausted,
} from "./dispatch-proposal"
import { liveDispatcherProposal } from "./dispatcher.fixture"

const input: DispatchPlanningInput = {
  goal: "Add a footer",
  network: { validationNames: ["test"], activeLines: [] },
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

/** Scripted final messages; records what the Dispatcher sent. */
function scripted(
  replies: (string | object)[],
  baseline: BaselineReport | null = null
) {
  const text = (reply: string | object) =>
    typeof reply === "string" ? reply : JSON.stringify(reply)
  const queue = [...replies]
  const session = {
    prepare: vi.fn<DispatchSession["prepare"]>(async () => baseline),
    start: vi.fn<DispatchSession["start"]>(async () => text(queue.shift()!)),
    resume: vi.fn<DispatchSession["resume"]>(async () => text(queue.shift()!)),
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

describe("harness Dispatcher", () => {
  it("explores through one session and returns a valid proposal without corrections", async () => {
    const proposal = await valid()
    const { session, sessions } = scripted([proposal])
    const result = await new HarnessDispatcher("configured", sessions).plan(
      input
    )
    expect(result).toEqual({ proposal, baseline: null })
    expect(sessions.open).toHaveBeenCalledWith({
      model: "configured",
      repository: input.repository,
      checkBaseline: false,
      validation: input.validation,
      network: input.network,
    })
    const [system, message] = session.start.mock.calls[0]!
    // OpenCode, the default harness, offers the proposal tool.
    expect(system).toContain("## Submitting the Proposal")
    expect(system).toContain(proposalToolAgentName)
    expect(message).toContain(
      `submit the proposal with \`${proposalToolAgentName}\``
    )
    expect(system).toContain("untrusted context")
    expect(system).toContain("SAME canonical baseline")
    expect(system).toContain("ONLY plain paths")
    expect(system).toContain("read-only `explore` subagents")
    expect(system).toContain(
      "Otherwise use the available read/search tools directly"
    )
    expect(system).toContain('"validationNames":["test"]')
    expect(message).toContain("Add a footer")
    expect(session.resume).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("accepts a fenced final message", async () => {
    const proposal = await valid()
    const { sessions } = scripted([
      "```json\n" + JSON.stringify(proposal) + "\n```",
    ])
    expect(
      (await new HarnessDispatcher("configured", sessions).plan(input)).proposal
    ).toEqual(proposal)
  })

  it("corrects verification-only Stations inside the same session", async () => {
    const proposal = await valid()
    const invalid = JSON.parse(JSON.stringify(proposal)) as typeof proposal
    invalid.lines[0]!.stations[0]!.manifest.repositoryChange = {
      kind: "verification" as "tests",
      description: "Run existing tests",
    }
    const { session, sessions } = scripted([invalid, proposal])
    expect(
      (await new HarnessDispatcher("configured", sessions).plan(input)).proposal
    ).toEqual(proposal)
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
    const result = await new HarnessDispatcher("configured", sessions).plan(
      input
    )
    expect(result.proposal).toEqual(blocked)
    expect(session.resume).toHaveBeenCalledTimes(2)
    expect(session.resume.mock.calls[0]![0]).toContain(
      "evidence lint is not a configured project check"
    )
    expect(session.resume.mock.calls[0]![0]).toContain(
      `submit the complete corrected proposal with \`${proposalToolAgentName}\``
    )
  })

  it("asks for the proposal as the final message when the harness has no proposal tool", async () => {
    const proposal = await valid()
    const blocked = JSON.parse(JSON.stringify(proposal)) as typeof proposal
    blocked.lines[0]!.stations[0]!.manifest.expectedEvidence = ["lint"]
    const { session, sessions } = scripted([blocked, proposal])
    const model = "anthropic/claude-haiku-4-5-20251001"
    await new HarnessDispatcher(model, sessions, {
      harness: "claude-code",
      model,
    } as RoleExecution).plan(input)
    const [system, message] = session.start.mock.calls[0]!
    expect(system).not.toContain("## Submitting the Proposal")
    expect(message).toContain("reply with only the proposal JSON")
    expect(session.resume.mock.calls[0]![0]).toContain(
      "Reply with the complete corrected proposal JSON as your final message."
    )
  })

  it("accepts omissions that cannot change the plan instead of asking for a resubmission", async () => {
    const proposal = await valid()
    // The live rejection: a Manifest without `dependencies` and a null `baselineFix`.
    const loose = structuredClone(proposal) as unknown as Loose
    delete loose.lines[0]!.stations[0]!.manifest.dependencies
    delete loose.lines[0]!.stations[0]!.manifest.avoidAreas
    loose.baselineFix = null
    loose.findings = null
    const reply = proposalSubmissionReply(
      { proposal: loose },
      input.network,
      null
    )
    expect(reply).toMatchObject({ accepted: true })
    expect(reply.text.startsWith(proposalAcceptedReply)).toBe(true)
    const { session, sessions } = scripted([loose])
    const result = await new HarnessDispatcher("configured", sessions).plan(
      input
    )
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
      proposalSubmissionReply({ proposal: wrong }, input.network, null).accepted
    ).toBe(false)
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
    const result = await new HarnessDispatcher("configured", sessions).plan(
      input
    )
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
    const reply = proposalSubmissionReply(
      { proposal: missing },
      input.network,
      null
    )
    expect(reply.accepted).toBe(false)
    expect(reply.text).toContain(
      '"path":"lines.0.stations.0.manifest.invariants"'
    )
  })

  it("answers proposal tool submissions with the checks the Workflow applies", async () => {
    const proposal = await valid()
    expect(
      proposalSubmissionReply({ proposal }, input.network, null)
    ).toMatchObject({
      accepted: true,
      text: expect.stringContaining("Accepted"),
    })
    // A model may pass the proposal as JSON text instead of an object.
    expect(
      proposalSubmissionReply(
        { proposal: JSON.stringify(proposal) },
        input.network,
        null
      ).accepted
    ).toBe(true)

    const blocked = JSON.parse(JSON.stringify(proposal)) as typeof proposal
    blocked.lines[0]!.stations[0]!.manifest.expectedEvidence = ["lint"]
    const assessment = proposalSubmissionReply(
      { proposal: blocked },
      input.network,
      null
    )
    expect(assessment.accepted).toBe(false)
    expect(assessment.text).toContain(
      "evidence lint is not a configured project check"
    )
    expect(assessment.text).toContain(
      "submit the complete corrected proposal again"
    )

    const schema = proposalSubmissionReply(
      { proposal: { summary: "Missing lines" } },
      input.network,
      null
    )
    expect(schema.accepted).toBe(false)
    expect(schema.text).toContain('"path":"lines"')

    expect(proposalSubmissionReply({}, input.network, null)).toMatchObject({
      accepted: false,
      text: expect.stringContaining("`proposal` argument"),
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
      network: { ...input.network, validationNames: ["build", "test"] },
    }
    expect(
      (await new HarnessDispatcher("configured", sessions).plan(goal)).proposal
    ).toEqual(corrected)
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
    const error = await new HarnessDispatcher("configured", sessions)
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

  it("makes the last submission final once the harness stops after repeated rejections", async () => {
    const invalid = JSON.stringify({ ...liveDispatcherProposal, extra: 1 })
    const { session, sessions } = scripted([])
    session.start.mockRejectedValueOnce(
      new ProposalSubmissionsExhausted(invalid)
    )
    const error = await new HarnessDispatcher("configured", sessions)
      .plan(input)
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(DispatchProposalError)
    expect(session.resume).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()

    // A still-blocked proposal is saved, as after the last correction.
    const blocked = await valid()
    blocked.lines[0]!.stations[0]!.manifest.expectedEvidence = ["lint"]
    const later = scripted(["no JSON"])
    later.session.resume.mockRejectedValueOnce(
      new ProposalSubmissionsExhausted(JSON.stringify(blocked))
    )
    const result = await new HarnessDispatcher(
      "configured",
      later.sessions
    ).plan(input)
    expect(later.session.resume).toHaveBeenCalledOnce()
    expect(result.proposal).toEqual(blocked)
  })

  it("treats a final message without JSON as a schema problem", async () => {
    const proposal = await valid()
    const { session, sessions } = scripted(["I explored the repo.", proposal])
    await new HarnessDispatcher("configured", sessions).plan(input)
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
    expect(
      (await new HarnessDispatcher("configured", sessions).plan(input)).proposal
    ).toEqual(proposal)
    expect(session.resume).not.toHaveBeenCalled()
  })

  it("tells the model where its JSON fails but keeps the parser out of the error", async () => {
    const broken = '{"summary":"x" oops}'
    const { session, sessions } = scripted([broken, broken, broken])
    const error = await new HarnessDispatcher("configured", sessions)
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

  it("supplies a trusted baseline report and keeps a baseline fix only when checks failed", async () => {
    const proposal = (
      await new FakeDispatchPlanner().plan({ ...input, checkBaseline: true })
    ).proposal
    const failing = scripted([proposal], failingBaseline)
    const result = await new HarnessDispatcher(
      "configured",
      failing.sessions
    ).plan({ ...input, checkBaseline: true })
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
      (await new HarnessDispatcher("configured", passing.sessions).plan(input))
        .proposal.baselineFix
    ).toBeUndefined()
    expect(passing.session.resume.mock.calls[0]![0]).toContain(
      "baseline checks did not fail"
    )
  })

  it("closes the session and leaves transient failures to the durable execution layer", async () => {
    const { session, sessions } = scripted([])
    session.start.mockRejectedValueOnce(new Error("429"))
    await expect(
      new HarnessDispatcher("configured", sessions).plan(input)
    ).rejects.toThrow("429")
    expect(session.close).toHaveBeenCalledOnce()
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
