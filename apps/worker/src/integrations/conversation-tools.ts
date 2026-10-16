import {
  dispatcherToolArguments,
  domainEventSchema,
  lineIdentities,
  lineMarking,
  stationWheres,
  type DispatcherReadTool,
  type DispatcherToolArguments,
  type NetworkSnapshot,
} from "@terminus/protocol"
import { lineStops } from "@terminus/domain"
import { parseToolArguments, trainWhere } from "@terminus/agent-runtime"
import type { NetworkStore } from "./network-store"
import type { ConversationStore } from "./conversation-store"

const notFound = (kind: string, id: string) =>
  JSON.stringify({ error: `No ${kind} ${id} in this network` })

/**
 * Runs the Dispatcher's read tools against D1. The network always comes from
 * the turn, never from the arguments, so an id from another network is
 * simply not found. Results are JSON text; the turn caps and labels them.
 */
export class ConversationToolRunner {
  readonly #db: D1Database
  readonly #store: NetworkStore
  readonly #conversations: ConversationStore
  readonly #networkId: string
  #snapshot: Promise<NetworkSnapshot | null> | undefined
  constructor(input: {
    db: D1Database
    store: NetworkStore
    conversations: ConversationStore
    networkId: string
  }) {
    this.#db = input.db
    this.#store = input.store
    this.#conversations = input.conversations
    this.#networkId = input.networkId
  }

  /** One snapshot per round, so a round's answers agree with each other. */
  #network(): Promise<NetworkSnapshot> {
    this.#snapshot ??= this.#store.snapshot(this.#networkId)
    return this.#snapshot.then((snapshot) => {
      if (!snapshot) throw new Error("Unknown network")
      return snapshot
    })
  }

  async run(name: DispatcherReadTool, raw: unknown): Promise<string> {
    const parsed = parseToolArguments(dispatcherToolArguments[name], raw)
    if (!parsed.ok) return JSON.stringify({ error: parsed.problem })
    switch (name) {
      case "terminus_station":
        return this.station(
          parsed.value as DispatcherToolArguments<typeof name>
        )
      case "terminus_line":
        return this.line(parsed.value as DispatcherToolArguments<typeof name>)
      case "terminus_plan":
        return this.plan(parsed.value as DispatcherToolArguments<typeof name>)
      case "terminus_activity":
        return this.activity(
          parsed.value as DispatcherToolArguments<typeof name>
        )
      case "terminus_search":
        return this.search(parsed.value as DispatcherToolArguments<typeof name>)
      case "terminus_conversation":
        return this.conversation(
          parsed.value as DispatcherToolArguments<typeof name>
        )
    }
  }

  async station({
    stationId,
  }: DispatcherToolArguments<"terminus_station">): Promise<string> {
    const snapshot = await this.#network()
    const station = snapshot.stations.find((s) => s.id === stationId)
    if (!station) return notFound("Station", stationId)
    const where = stationWheres(snapshot).get(station.id)
    const review = await this.#db
      .prepare(
        "SELECT result, recorded_at FROM conductor_reviews WHERE station_id = ? AND network_id = ? ORDER BY recorded_at DESC LIMIT 1"
      )
      .bind(station.id, this.#networkId)
      .first<{ result: string; recorded_at: string }>()
    const cars = snapshot.cars.filter((car) => car.stationId === station.id)
    return JSON.stringify({
      id: station.id,
      name: station.name,
      lineId: station.lineId,
      line: snapshot.lines.find((l) => l.id === station.lineId)?.name,
      where,
      state: station.state,
      revisionCount: station.revisionCount,
      retryCount: station.retryCount ?? 0,
      ...(station.removalRequest
        ? { removalRequested: station.removalRequest.reason }
        : {}),
      manifest: station.manifest,
      latestReview: review
        ? { recordedAt: review.recorded_at, verdict: JSON.parse(review.result) }
        : null,
      cars: cars.map((car) => ({
        id: car.id,
        trainId: car.trainId,
        position: car.position,
        acceptedCommit: car.acceptedCommit,
        acceptedAt: car.acceptedAt,
        changedPaths: car.changedPaths.slice(0, 30),
        review: { summary: car.review.summary, findings: car.review.findings },
        evidence: car.evidence.checks.map((check) => ({
          name: check.name,
          status: check.status,
        })),
      })),
    })
  }

  async line({ lineId }: DispatcherToolArguments<"terminus_line">) {
    const snapshot = await this.#network()
    const line = snapshot.lines.find((l) => l.id === lineId)
    if (!line) return notFound("Line", lineId)
    const name = (id: string) =>
      snapshot.stations.find((s) => s.id === id)?.name ?? id
    const trains = snapshot.trains.filter((t) => t.train.lineId === line.id)
    const identity = lineIdentities(snapshot).get(line.id)
    return JSON.stringify({
      id: line.id,
      name: line.name,
      live: identity?.live ?? true,
      // A finished Line's number and colour pass to the next Line laid.
      ...(identity?.live ? lineMarking(identity) : {}),
      ...(identity?.finishedAt ? { finishedAt: identity.finishedAt } : {}),
      origin: line.origin ?? { kind: "depot" },
      destination: line.destination ?? { kind: "terminus" },
      route: lineStops(line).map((stop) => ({
        kind: stop.kind,
        stationId: stop.stationId,
        station: name(stop.stationId),
      })),
      trains: trains.map(({ train, stateEnteredAt }) => ({
        id: train.id,
        status: train.state.status,
        where: trainWhere(train.state),
        since: stateEnteredAt,
        state: train.state,
        cars: snapshot.cars
          .filter((car) => car.trainId === train.id)
          .map((car) => ({
            id: car.id,
            station: name(car.stationId),
            acceptedAt: car.acceptedAt,
          })),
        unloadPolicy:
          snapshot.unloadPolicies?.find((p) => p.trainId === train.id) ?? null,
      })),
      holds: snapshot.holds.filter(({ scope }) =>
        scope.kind === "network"
          ? true
          : scope.kind === "line"
            ? scope.lineId === line.id
            : scope.kind === "train"
              ? trains.some((t) => t.train.id === scope.trainId)
              : false
      ),
      crossings: (snapshot.crossings ?? [])
        .filter(
          (c) =>
            c.lineId === line.id || line.stationIds.includes(c.sourceStationId)
        )
        .map((c) => ({
          id: c.id,
          receivingLineId: c.lineId,
          sourceStation: name(c.sourceStationId),
          state: c.state.status,
        })),
      junctions: (snapshot.junctions ?? [])
        .filter(
          (j) =>
            j.outgoingLineId === line.id || j.incomingLineIds.includes(line.id)
        )
        .map((j) => ({
          id: j.id,
          name: j.name,
          status: j.state.status,
          role: j.outgoingLineId === line.id ? "outgoing" : "incoming",
        })),
    })
  }

  async plan({ planId }: DispatcherToolArguments<"terminus_plan">) {
    const snapshot = await this.#network()
    const plan = snapshot.plans.find((p) => p.id === planId)
    if (!plan) return notFound("plan", planId)
    const proposal = "proposal" in plan.state ? plan.state.proposal : undefined
    return JSON.stringify({
      id: plan.id,
      goal: plan.goal,
      createdAt: plan.createdAt,
      ...(plan.request ? { request: plan.request } : {}),
      ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
      status: plan.state.status,
      ...(plan.state.status === "failed"
        ? {
            message: plan.state.message,
            ...(plan.state.reason ? { reason: plan.state.reason } : {}),
          }
        : {}),
      revisionChain: {
        ...(plan.revises ? { revises: plan.revises } : {}),
        revisedBy: snapshot.plans
          .filter((p) => p.revises === plan.id)
          .map((p) => p.id),
      },
      ...(proposal
        ? {
            proposal: {
              summary: proposal.summary,
              lines: proposal.lines.map((line) => ({
                key: line.key,
                name: line.name,
                stations: line.stations.map((s) => ({
                  key: s.key,
                  name: s.name,
                  goal: s.manifest.goal,
                  expectedAreas: s.manifest.expectedAreas,
                })),
              })),
              junctions: (proposal.junctions ?? []).map((j) => ({
                key: j.key,
                name: j.name,
                goal: j.brief.goal,
              })),
              ...(proposal.baselineFix
                ? { baselineFix: proposal.baselineFix.reason }
                : {}),
              findings: proposal.findings ?? [],
            },
          }
        : {}),
      ...("assessment" in plan.state
        ? { assessment: plan.state.assessment }
        : {}),
      ...("lineIds" in plan.state ? { lineIds: plan.state.lineIds } : {}),
    })
  }

  async activity({
    entityId,
    limit,
  }: DispatcherToolArguments<"terminus_activity">) {
    const { results } = await this.#db
      .prepare(
        `SELECT seq, payload, occurred_at FROM events
         WHERE network_id = ?1 AND (train_id = ?2 OR station_id = ?2
           OR json_extract(payload, '$.planId') = ?2)
         ORDER BY seq DESC LIMIT ?3`
      )
      .bind(this.#networkId, entityId, limit ?? 20)
      .all<{ seq: number; payload: string; occurred_at: string }>()
    if (!results.length)
      return JSON.stringify({ events: [], note: `No events for ${entityId}` })
    return JSON.stringify({
      events: results.flatMap((row) => {
        const event = domainEventSchema.safeParse(JSON.parse(row.payload))
        return event.success
          ? [{ seq: row.seq, at: row.occurred_at, event: event.data }]
          : []
      }),
    })
  }

  async search({ query }: DispatcherToolArguments<"terminus_search">) {
    const snapshot = await this.#network()
    const needle = query.toLowerCase()
    const has = (text: string) => text.toLowerCase().includes(needle)
    const limit = 20
    const stations = snapshot.stations
      .filter((s) => has(s.name) || has(s.manifest.goal))
      .slice(0, limit)
      .map((s) => ({ id: s.id, name: s.name, lineId: s.lineId }))
    const plans = snapshot.plans
      .filter((p) => has(p.goal))
      .slice(0, limit - stations.length)
      .map((p) => ({
        id: p.id,
        goal: p.goal.slice(0, 200),
        status: p.state.status,
      }))
    const left = Math.max(0, limit - stations.length - plans.length)
    const found = left
      ? await this.#conversations.search(this.#networkId, query, left)
      : { conversations: [], messages: [] }
    return JSON.stringify({
      stations,
      plans,
      conversations: found.conversations,
      userMessages: found.messages
        .slice(0, Math.max(0, left - found.conversations.length))
        .map((m) => ({ ...m, text: m.text.slice(0, 300) })),
    })
  }

  async conversation({
    conversationId,
    before,
  }: DispatcherToolArguments<"terminus_conversation">) {
    const conversation = await this.#conversations.conversation(conversationId)
    if (!conversation || conversation.networkId !== this.#networkId)
      return notFound("conversation", conversationId)
    const messages = await this.#conversations.readableMessagesBefore(
      conversationId,
      before,
      20
    )
    return JSON.stringify({
      id: conversation.value.id,
      title: conversation.value.title,
      messages: messages.map(({ seq, at, message }) => ({
        seq,
        at,
        ...(message.kind === "user"
          ? { from: "user", text: message.text }
          : message.kind === "dispatcher"
            ? { from: "dispatcher", text: message.text }
            : message.kind === "plan"
              ? { plan: message.planId }
              : {}),
      })),
      ...(messages.length === 20 ? { nextBefore: messages.at(-1)!.seq } : {}),
    })
  }
}
