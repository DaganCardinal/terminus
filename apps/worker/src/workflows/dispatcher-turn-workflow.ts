import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers"
import { TURN_MAX_ROUNDS, type ChatResponse } from "@terminus/agent-runtime"
import { errorDetail, type TurnErrorKind } from "@terminus/protocol"
import { conversationPorts, resolveTurnModel, turnPorts } from "../agents/ports"
import type { TurnParams } from "../agents/conversations"
import {
  buildTurnBrief,
  endTurnRun,
  recordRound,
  respondInTurn,
  startTurnPlanning,
  turnErrorKind,
} from "./conversation-operations"

const retries = {
  limit: 2,
  delay: "2 seconds",
  backoff: "exponential",
} as const

/**
 * One Dispatcher conversation turn: a few model rounds with read tools,
 * and at most one plan started through the existing planning path. Every
 * write is fenced to this turn, so a stopped turn's late writes are refused.
 */
export class DispatcherTurnWorkflow extends WorkflowEntrypoint<
  Env,
  TurnParams
> {
  async run(event: WorkflowEvent<TurnParams>, step: WorkflowStep) {
    const params = event.payload
    const closing = conversationPorts(this.env)
    try {
      // Settings changes apply from the next message.
      const model = await step.do("resolve model", { retries }, () =>
        resolveTurnModel(this.env, params.networkId)
      )
      const ports = turnPorts(this.env, params.networkId, model)
      const brief = await step.do("build brief", { retries }, () =>
        buildTurnBrief(ports, params)
      )
      // Reasoning is replayed only within this turn. It lives in these
      // step results, never in D1.
      const providerStates: Record<number, unknown> = {}
      let position = 1
      let planned = false
      let error: TurnErrorKind | undefined
      for (let round = 0; ; round++) {
        if (round >= TURN_MAX_ROUNDS) {
          error = "round_limit"
          break
        }
        // Provider state is opaque JSON, so the step returns the reply as text.
        const reply = JSON.parse(
          await step.do(
            `respond ${round}`,
            { retries: { ...retries, limit: 1 }, timeout: "5 minutes" },
            async () =>
              JSON.stringify(
                await respondInTurn(ports, params, brief, providerStates)
              )
          )
        ) as ChatResponse | null
        if (!reply) return { turnId: params.turnId, status: "stopped" }
        if (reply.providerState !== undefined)
          providerStates[position] = reply.providerState
        const outcome = await step.do(`tools ${round}`, { retries }, () =>
          recordRound(ports, params, reply, position, planned)
        )
        if (outcome.kind === "fenced")
          return { turnId: params.turnId, status: "stopped" }
        if (outcome.kind === "done") {
          error = outcome.error
          break
        }
        position = outcome.next
        if (outcome.planning) {
          const call = outcome.planning
          const started = await step.do(
            `start planning ${round}`,
            { retries },
            () => startTurnPlanning(ports, params, call, position)
          )
          if (started.kind === "fenced")
            return { turnId: params.turnId, status: "stopped" }
          position = started.next
          // After a plan starts, one closing line, then the turn ends.
          planned ||= started.kind === "planned"
        }
      }
      await step.do("finish turn", { retries }, () =>
        endTurnRun(ports, params, error)
      )
      return { turnId: params.turnId, status: error ?? "answered" }
    } catch (failure) {
      const kind = turnErrorKind(failure)
      console.error("dispatcher.turn_failed", {
        turnId: params.turnId,
        kind,
        errorName: failure instanceof Error ? failure.name : "UnknownError",
        detail: errorDetail(failure),
      })
      // Only the kind is recorded, never the error's message.
      await step.do("record failure", { retries }, () =>
        endTurnRun(closing, params, kind)
      )
      return { turnId: params.turnId, status: kind }
    }
  }
}
