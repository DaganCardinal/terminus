/**
 * Error messages can carry credentials or repository content, so logs
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
