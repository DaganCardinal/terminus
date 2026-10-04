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
import { domainEventSchema, holdSchema } from "./events"
import { workManifestSchema } from "./manifest"

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
