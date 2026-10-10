import { describe, expect, it, vi } from "vitest"
import type { BaselineReport } from "@terminus/domain"
import { dispatchProposalSchema } from "@terminus/protocol"
import {
  HarnessDispatcher,
  type DispatchSession,
  type DispatchSessionFactory,
} from "./dispatcher-agent"
import {
  FakeDispatchPlanner,
  type DispatchPlanningInput,
} from "./dispatch-planner"
import { DispatchProposalError } from "./dispatch-proposal"
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
    })
    const [system, message] = session.start.mock.calls[0]!
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
    const broken = '{"summary":"x",}'
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
