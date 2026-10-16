import { env } from "cloudflare:test"
import { describe, expect, it, vi } from "vitest"
import {
  FakeDispatchPlanner,
  HarnessDispatcher,
  type DispatchSession,
} from "@terminus/agent-runtime"
import type { PlanDraft, PlanStation } from "@terminus/protocol"
import { seedNetwork, testPorts } from "../../test/fixtures"
import { DispatchDraftStore } from "../integrations/dispatch-draft-store"
import { prepareDispatchPlan } from "../workflows/dispatch-operations"
import {
  launchPlannedLines,
  proposeConversationPlan,
  type DispatchPlanningPorts,
} from "./dispatch-planning"
import { DispatchError } from "./dispatcher"

function planning() {
  const base = testPorts()
  const ports: DispatchPlanningPorts = {
    ...base.dispatcher,
    planner: new FakeDispatchPlanner(),
    startPlanning: async () => {},
    wakePlan: async () => {},
    retryPlan: async () => {},
    stopPlan: async () => {},
  }
  return { base, ports }
}
const origin = (planId: string, revises?: string) => ({
  planId,
  conversationId: "conversation-1",
  turnId: "turn-1",
  request: { userMessage: "Add a footer", relatedStationIds: [] },
  ...(revises ? { revises } : {}),
})
const station = (key: string, subject: string): PlanStation => ({
  key,
  name: `${key} the ${subject}`,
  goal: `${key === "build" ? "Add" : "Test"} the ${subject}`,
  changeKind: "implementation",
  changeDescription: `Change the ${subject}`,
  scope: [`The ${subject} only`],
  expectedAreas: [`src/${subject}-${key}.tsx`],
  invariants: ["Existing pages are unchanged"],
  acceptanceCriteria: [`The ${subject} works`],
  expectedEvidence: ["test"],
})
/** A plan as its plan tools saved it. */
const planDraft = (subject: string): PlanDraft => ({
  outline: {
    summary: `One Line adds the ${subject}.`,
    lines: [
      {
        key: "page",
        name: "Page",
        unloadRecommendation: { mode: "auto", reason: "Small." },
        stations: ["build", "check"],
      },
    ],
  },
  stations: {
    build: station("build", subject),
    check: station("check", subject),
  },
})

describe("plans started by a conversation", () => {
  it("prepares one plan at a time and is idempotent for its own retry", async () => {
    const { base, ports } = planning()
    const network = await seedNetwork(base)
    const first = await proposeConversationPlan(ports, network.id, {
      brief: "Add a footer",
      checkBaseline: false,
      origin: origin("dispatch-a-1"),
    })
    expect(first).toMatchObject({
      conversationId: "conversation-1",
      turnId: "turn-1",
      request: { userMessage: "Add a footer" },
      state: { status: "planning" },
    })
    // A retried step finds the plan it already created.
    expect(
      (
        await proposeConversationPlan(ports, network.id, {
          brief: "Add a footer",
          checkBaseline: false,
          origin: origin("dispatch-a-1"),
        })
      ).id
    ).toBe(first.id)
    await expect(
      proposeConversationPlan(ports, network.id, {
        brief: "Add a header",
        checkBaseline: false,
        origin: origin("dispatch-b-1"),
      })
    ).rejects.toThrow(DispatchError)
  })

  it("copies the revised plan's draft and refuses to revise a launched plan", async () => {
    const { base, ports } = planning()
    const network = await seedNetwork(base)
    const first = await proposeConversationPlan(ports, network.id, {
      brief: "Add a footer",
      checkBaseline: false,
      origin: origin("dispatch-c-1"),
    })
    await prepareDispatchPlan(ports, first.id)
    await env.DB.prepare(
      "INSERT INTO dispatch_drafts (plan_id, part, key, body, updated_at) VALUES (?, 'station', 'footer', '{}', 'now')"
    )
      .bind(first.id)
      .run()
    const revision = await proposeConversationPlan(ports, network.id, {
      brief: "Add a footer with links",
      checkBaseline: false,
      origin: origin("dispatch-c-2", first.id),
    })
    expect(revision.revises).toBe(first.id)
    const copied = await env.DB.prepare(
      "SELECT key FROM dispatch_drafts WHERE plan_id = ?"
    )
      .bind(revision.id)
      .all<{ key: string }>()
    expect(copied.results.map((r) => r.key)).toEqual(["footer"])
    // The first session's checkpoint keeps the copied draft.
    await new DispatchDraftStore(env.DB).begin(revision.id, "{}", null)
    expect(
      Object.keys(
        (await new DispatchDraftStore(env.DB).read(revision.id)).stations
      )
    ).toEqual([])
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM dispatch_drafts WHERE plan_id = ?"
      )
        .bind(revision.id)
        .first<{ n: number }>())!.n
    ).toBe(1)
    const superseded = (await base.store.dispatchPlan(first.id))!.value
    expect(superseded.state).toMatchObject({
      status: "failed",
      reason: "superseded",
      supersededBy: revision.id,
    })

    await prepareDispatchPlan(ports, revision.id)
    await launchPlannedLines(ports, network.id, revision.id)
    await expect(
      proposeConversationPlan(ports, network.id, {
        brief: "Change it again",
        checkBaseline: false,
        origin: origin("dispatch-c-3", revision.id),
      })
    ).rejects.toMatchObject({ status: 409 })
  })

  it("retries a revision whose harness failed instead of returning the revised plan", async () => {
    const { base, ports } = planning()
    const network = await seedNetwork(base)
    const drafts = new DispatchDraftStore(env.DB)
    const first = await proposeConversationPlan(ports, network.id, {
      brief: "Add a footer",
      checkBaseline: false,
      origin: origin("dispatch-d-1"),
    })
    await prepareDispatchPlan(ports, first.id)
    await drafts.save(first.id, { stations: {} }, planDraft("footer"))
    const revision = await proposeConversationPlan(ports, network.id, {
      brief: "Add a header instead of the footer",
      checkBaseline: false,
      origin: origin("dispatch-d-2", first.id),
    })
    const context = "trusted-test-context"
    const start = vi
      .fn<DispatchSession["start"]>()
      .mockRejectedValueOnce(new Error("OpenCode did not start"))
      .mockImplementationOnce(async () => {
        await drafts.save(
          revision.id,
          await drafts.read(revision.id),
          planDraft("header")
        )
        await drafts.accept(revision.id)
        return "Plan accepted."
      })
    const session: DispatchSession = {
      restore: () => drafts.restore(revision.id, context),
      prepare: async () => {
        await drafts.begin(revision.id, context, null)
        return null
      },
      start,
      resume: async () => "",
      draft: () => drafts.read(revision.id),
      revising: () => drafts.revising(revision.id),
      close: async () => {},
    }
    ports.planner = new HarnessDispatcher("fake", { open: () => session })

    // The copied footer draft passes every check, but nothing changed it.
    await expect(prepareDispatchPlan(ports, revision.id)).rejects.toThrow(
      "OpenCode did not start"
    )
    expect(
      (await base.store.dispatchPlan(revision.id))!.value.state.status
    ).toBe("planning")
    // The durable retry finds the checkpoint, and still runs the planner.
    await prepareDispatchPlan(ports, revision.id)
    expect(start).toHaveBeenCalledTimes(2)
    expect(
      (await base.store.dispatchPlan(revision.id))!.value.state
    ).toMatchObject({
      status: "ready",
      proposal: {
        lines: [
          {
            stations: [
              { manifest: { goal: "Add the header" } },
              { manifest: { goal: "Test the header" } },
            ],
          },
        ],
      },
    })
  })
})
