import type { GateDecision } from "./engineer"
import type { DomainEvent } from "./events"

export type TransitionErrorCode =
  | "invalid_state"
  | "invalid_input"
  | "gate_closed"
  | "stale_base"
  | "not_fast_forward"
  | "required_checks_failed"
  | "open_conflicts"
  | "stations_remaining"

export type TransitionError =
  | {
      code: "gate_closed"
      message: string
      decision: Exclude<GateDecision, { kind: "clear" }>
    }
  | { code: Exclude<TransitionErrorCode, "gate_closed">; message: string }

/**
 * The result of a domain transition. On success, `events` must be persisted
 * in the same batch as `value`.
 */
export type Transition<T> =
  | { ok: true; value: T; events: DomainEvent[] }
  | { ok: false; error: TransitionError }

export function accept<T>(value: T, events: DomainEvent[]): Transition<T> {
  return { ok: true, value, events }
}

export function reject(
  code: Exclude<TransitionErrorCode, "gate_closed">,
  message: string
): Transition<never> {
  return { ok: false, error: { code, message } }
}

export function gateClosed(
  decision: Exclude<GateDecision, { kind: "clear" }>,
  message: string
): Transition<never> {
  return { ok: false, error: { code: "gate_closed", message, decision } }
}
