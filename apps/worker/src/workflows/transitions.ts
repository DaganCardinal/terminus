import type { Transition, TransitionError } from "@terminus/domain"

/** A domain transition was rejected where orchestration expected it to apply. */
export class TransitionRejectedError extends Error {
  readonly error: TransitionError

  constructor(error: TransitionError) {
    super(`${error.code}: ${error.message}`)
    this.name = "TransitionRejectedError"
    this.error = error
  }
}

export function applied<T>(
  transition: Transition<T>
): Extract<Transition<T>, { ok: true }> {
  if (!transition.ok) throw new TransitionRejectedError(transition.error)
  return transition
}
