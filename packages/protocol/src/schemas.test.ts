import type {
  DomainEvent,
  Evidence,
  Hold,
  Proposal,
  WorkManifest,
} from "@terminus/domain"
import { describe, expect, expectTypeOf, it } from "vitest"
import type { z } from "zod"
import { evidenceSchema, proposalSchema } from "./agents"
import { carSchema } from "./crossing"
import { dispatchPlanSchema } from "./dispatch"
import { domainEventSchema, holdSchema } from "./events"
import { integrationAttemptSchema } from "./integration"
import { workManifestSchema } from "./manifest"
import { technicianRepairSchema } from "./technician"

describe("schemas match the domain", () => {
  it("covers every domain event and shared shape exactly", () => {
    expectTypeOf<
      z.infer<typeof domainEventSchema>
    >().toEqualTypeOf<DomainEvent>()
    expectTypeOf<
      z.infer<typeof workManifestSchema>
    >().toEqualTypeOf<WorkManifest>()
    expectTypeOf<z.infer<typeof proposalSchema>>().toEqualTypeOf<Proposal>()
    expectTypeOf<z.infer<typeof evidenceSchema>>().toEqualTypeOf<Evidence>()
    expectTypeOf<z.infer<typeof holdSchema>>().toEqualTypeOf<Hold>()
  })
})

describe("domainEventSchema", () => {
  it("parses a valid event", () => {
    const event: DomainEvent = {
      type: "car.attached",
      carId: "c",
      trainId: "t",
      stationId: "s",
      acceptedCommit: "abc",
    }
    expect(domainEventSchema.parse(event)).toEqual(event)
  })

  it("rejects unknown event types and missing fields", () => {
    expect(
      domainEventSchema.safeParse({ type: "train.teleported", trainId: "t" })
        .success
    ).toBe(false)
    expect(
      domainEventSchema.safeParse({ type: "train.departed", trainId: "t" })
        .success
    ).toBe(false)
  })

  it("rejects a block with no issues", () => {
    expect(
      domainEventSchema.safeParse({
        type: "train.blocked",
        trainId: "t",
        issues: [],
      }).success
    ).toBe(false)
  })
  it("validates the Dispatcher alert for exhausted Station retries", () => {
    const event: DomainEvent = {
      type: "dispatcher.user_attention_requested",
      trainId: "t",
      stationId: "s",
      issues: [
        {
          kind: "station_retries_exhausted",
          detail: "User intervention required",
        },
      ],
    }
    expect(domainEventSchema.parse(event)).toEqual(event)
    expect(domainEventSchema.safeParse({ ...event, issues: [] }).success).toBe(
      false
    )
  })
})

describe("workManifestSchema", () => {
  it("rejects a manifest without a goal", () => {
    expect(
      workManifestSchema.safeParse({
        goal: "",
        scope: [],
        expectedAreas: [],
        avoidAreas: [],
        contracts: [],
        invariants: [],
        dependencies: [],
        acceptanceCriteria: [],
        expectedEvidence: [],
      }).success
    ).toBe(false)
  })
})

describe("agent provenance", () => {
  const model = "@cf/zai-org/glm-5.3-flash"
  const car = (stationAgent: object, review: object) => ({
    id: "car-1",
    trainId: "train-1",
    stationId: "station-1",
    position: 1,
    manifest: {
      goal: "Add a page",
      scope: [],
      expectedAreas: [],
      avoidAreas: [],
      contracts: [],
      invariants: [],
      dependencies: [],
      acceptanceCriteria: [],
      expectedEvidence: [],
    },
    stationAgent,
    sourceCommit: "source",
    acceptedCommit: "accepted",
    changedPaths: [],
    evidence: { checks: [] },
    agentSummary: null,
    review: { summary: "Accepted", findings: [], ...review },
    acceptedAt: "2026-10-14T00:00:00.000Z",
  })

  it("keeps the reasoning level an agent ran at", () => {
    const agent = {
      harness: "opencode@1.18.32",
      model,
      provider: "workers-ai",
      harnessVersion: "1.18.32",
      reasoning: "high",
    }
    const parsed = carSchema.parse(car(agent, agent))
    expect(parsed.stationAgent).toEqual(agent)
    expect(parsed.review.reasoning).toBe("high")
    for (const schema of [
      proposalSchema.shape.agent,
      technicianRepairSchema.shape.agent,
      dispatchPlanSchema.shape.agent.unwrap(),
      integrationAttemptSchema.shape.review.unwrap().unwrap(),
    ])
      expect(
        schema.parse({ verdict: "accept", summary: "", findings: [], ...agent })
      ).toMatchObject({ reasoning: "high" })
  })

  it("still parses Cars recorded before reasoning levels", () => {
    const parsed = carSchema.parse(
      car({ harness: "opencode", model }, { model })
    )
    expect(parsed.stationAgent).toEqual({ harness: "opencode", model })
    expect(parsed.review).not.toHaveProperty("reasoning")
  })
})
