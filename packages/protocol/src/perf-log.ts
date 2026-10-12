/**
 * TEMPORARY benchmark instrumentation. Every line is `[perf] <event>` with a
 * JSON payload, so a run's logs can be filtered with `grep '\[perf\]'`.
 * Remove this file and its callers once the speed analysis is done.
 */
// The protocol package runs everywhere and has no DOM or Workers typings.
declare const console: { info(message: string): void }

export function perf(
  event: string,
  fields: Record<string, unknown> = {}
): void {
  console.info(
    `[perf] ${event} ${JSON.stringify({ t: new Date().toISOString(), ...fields })}`
  )
}

/**
 * One `[perf]` line as the perf Tail Worker (`apps/perf-tail`) stores it in
 * R2. Workers Logs loses whole invocations, so analysis reads lines back from
 * `GET /api/perf-logs` instead of the dashboard export.
 */
export interface PerfLogRecord {
  /** When the line was logged. */
  t: string
  /** The class or handler that logged it, such as `TrainWorkflow`. */
  entrypoint: string
  /** Lines that share this id were logged by one invocation. */
  invocation: string
  /** How that invocation ended, as the runtime reported it. */
  outcome: string
  /** The runtime cut that invocation's logs short. */
  truncated: boolean
  message: string
}

export const PERF_LOG_PREFIX = "perf/"

/**
 * Stored objects are grouped by the UTC hour of their lines
 * (`perf/2026-10-12T15/…`), so reading a time window lists only its hours.
 */
export function perfLogHour(time: Date | number | string): string {
  return new Date(time).toISOString().slice(0, 13)
}

/**
 * Error messages can carry credentials or repository content, so perf lines
 * record only the error's type and, when it has them, its machine-readable
 * code (such as an Artifacts API code), HTTP status, raw numeric API code and
 * request shape (`POST /repos/:/fork`, no names), then the same for its
 * causes; the failing operation and phase say where.
 */
export function errorKind(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return typeof error
  const field = (name: string): unknown =>
    name in error ? (error as unknown as Record<string, unknown>)[name] : null
  const code = field("code")
  const status = field("status")
  const apiCode = field("apiCode")
  const operation = field("operation")
  const apiMessage = field("apiMessage")
  const details = [
    (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) ||
    (typeof code === "number" && Number.isSafeInteger(code))
      ? String(code)
      : null,
    typeof status === "number" && Number.isSafeInteger(status)
      ? `status ${status}`
      : null,
    typeof apiCode === "number" && Number.isSafeInteger(apiCode)
      ? `api ${apiCode}`
      : null,
    typeof operation === "string" &&
    /^[A-Z]{3,7} [A-Za-z0-9/:._-]{1,80}$/.test(operation)
      ? operation
      : null,
    // Adapters set this only to text already reduced to plain words.
    typeof apiMessage === "string" &&
    /^[A-Za-z0-9 .,:;'()/…-]{1,120}$/.test(apiMessage)
      ? `"${apiMessage}"`
      : null,
  ].filter((detail) => detail !== null)
  const kind = details.length
    ? `${error.name}(${details.join(", ")})`
    : error.name
  return error.cause !== undefined && depth < 2
    ? `${kind} <- ${errorKind(error.cause, depth + 1)}`
    : kind
}

/** Known platform failure phrases, matched in messages that are never logged. */
const failureClasses: [string, RegExp][] = [
  ["memory", /memory limit|out of memory|\boom\b/i],
  ["container-exited", /container.*(exit|stop|crash|kill)|not running/i],
  [
    "connection-lost",
    /connection (lost|reset|closed)|disconnected|econnreset|broken pipe/i,
  ],
  [
    "object-reset",
    /durable object.*(reset|evicted|overloaded)|code was updated/i,
  ],
  ["timeout", /timed? ?out|deadline|aborted/i],
  ["overloaded", /overloaded|too many|capacity/i],
]

/**
 * Classifies a platform error whose type alone says nothing (Sandbox and RPC
 * errors are plain `Error`s). Messages can carry credentials, so only the
 * matched failure classes and a Cloudflare internal-error reference are
 * logged, never the message itself.
 */
export function errorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message) return undefined
  const classes = failureClasses
    .filter(([, pattern]) => pattern.test(error.message))
    .map(([name]) => name)
  const reference = /internal error; reference = ([a-z0-9]+)/.exec(
    error.message
  )?.[1]
  return [
    classes.length ? classes.join("|") : "unclassified",
    ...(reference ? [`reference=${reference}`] : []),
  ].join(" ")
}

/** Logs one operation's duration and outcome; `summary` adds fields from its result. */
export async function perfSpan<T>(
  event: string,
  fields: Record<string, unknown>,
  run: () => Promise<T>,
  summary?: (result: T) => Record<string, unknown>
): Promise<T> {
  const started = Date.now()
  try {
    const result = await run()
    perf(event, {
      ...fields,
      ok: true,
      ms: Date.now() - started,
      ...summary?.(result),
    })
    return result
  } catch (error) {
    perf(event, {
      ...fields,
      ok: false,
      ms: Date.now() - started,
      error: errorKind(error),
    })
    throw error
  }
}

/**
 * Sequential phases of one operation. Each `enter` closes the previous phase
 * with its own line; `finish` logs every phase's duration in one summary line.
 */
export class PerfPhases {
  readonly #event: string
  readonly #fields: Record<string, unknown>
  readonly #started = Date.now()
  readonly #durations: Record<string, number> = {}
  #phase: string | null = null
  #phaseStarted = Date.now()

  constructor(event: string, fields: Record<string, unknown>) {
    this.#event = event
    this.#fields = fields
    perf(`${event}.start`, fields)
  }

  enter(phase: string): void {
    this.#close()
    this.#phase = phase
    this.#phaseStarted = Date.now()
  }

  /** How long the current phase has run. */
  currentMs(): number {
    return Date.now() - this.#phaseStarted
  }

  finish(fields: Record<string, unknown> = {}): void {
    const failedIn = fields.ok === false ? this.#phase : undefined
    this.#close()
    perf(`${this.#event}.done`, {
      ...this.#fields,
      totalMs: Date.now() - this.#started,
      phases: this.#durations,
      ...(failedIn ? { failedIn } : {}),
      ...fields,
    })
  }

  #close(): void {
    if (!this.#phase) return
    const ms = Date.now() - this.#phaseStarted
    this.#durations[this.#phase] = (this.#durations[this.#phase] ?? 0) + ms
    perf(`${this.#event}.phase`, { ...this.#fields, phase: this.#phase, ms })
    this.#phase = null
  }
}

/**
 * Wraps a Workflow step callback so it logs only when the step really runs.
 * Cached steps replay without calling it, so replays add no lines. The gap
 * between one step's line and the next step's start is time spent waiting
 * (events, sleeps, scheduling).
 */
export function timedStep<T>(
  workflow: string,
  id: string,
  step: string,
  run: () => Promise<T>,
  summary?: (result: T) => Record<string, unknown>
): () => Promise<T> {
  return () => {
    perf("workflow.step_start", { workflow, id, step })
    return perfSpan("workflow.step", { workflow, id, step }, run, summary)
  }
}
