import type { AgentActivity, Harness } from "@terminus/protocol"
import {
  maxRejectedFinalizations,
  maxRejectedPlanCalls,
  maxRepeatedPlanFormatFailures,
  notSavedReply,
  planAcceptedReply,
  planToolAgentName,
  planToolNames,
} from "./dispatch-draft"
import { harnessTimelineScript } from "./opencode"

/** No tool output, reasoning, messages, commands or search expressions leave here. */
export function filteredHarnessActivity(
  harness: Harness,
  event: unknown,
  directory: string
): AgentActivity | null {
  if (!event || typeof event !== "object") return null
  // Native events are untrusted; every displayed field is allowlisted below.
  const e = event as {
    type?: string
    part?: {
      tool?: string
      state?: { input?: Record<string, unknown>; status?: string }
    }
    message?: {
      content?: {
        type?: string
        name?: string
        input?: Record<string, unknown>
      }[]
    }
    item?: { type?: string; exit_code?: number }
  }
  let name: unknown
  let input: Record<string, unknown> = {}
  let status: "running" | "completed" | "failed" = "completed"
  if (harness === "opencode" && e.type === "tool_use") {
    name = e.part?.tool
    input = e.part?.state?.input ?? {}
    const state = e.part?.state?.status
    if (state === "pending" || state === "running") status = "running"
    else if (state === "error") status = "failed"
    else if (state !== "completed") return null
    if (name === "task" && input.subagent_type !== "explore") return null
    // Literal names: this function runs in the Sandbox as source text.
    if (
      name === "terminus_set_plan_outline" ||
      name === "terminus_put_station" ||
      name === "terminus_inspect_plan"
    )
      return { kind: "phase", phase: "writing_plan" }
    if (name === "terminus_finalize_plan")
      return { kind: "phase", phase: "validating_proposal" }
  } else if (harness === "claude-code" && e.type === "assistant") {
    const block = e.message?.content?.[0]
    if (block?.type !== "tool_use") return null
    name = block.name
    input = block.input ?? {}
    status = "running"
  } else if (
    harness === "codex" &&
    (e.type === "item.started" || e.type === "item.completed")
  ) {
    if (e.item?.type !== "command_execution") return null
    name = "command"
    status =
      e.type === "item.started"
        ? "running"
        : e.item.exit_code === 0
          ? "completed"
          : "failed"
  } else return null

  const tools: Record<string, Extract<AgentActivity, { kind: "tool" }>> = {
    read: { kind: "tool", tool: "read", status },
    Read: { kind: "tool", tool: "read", status },
    grep: { kind: "tool", tool: "search", status },
    Grep: { kind: "tool", tool: "search", status },
    glob: { kind: "tool", tool: "list", status },
    Glob: { kind: "tool", tool: "list", status },
    list: { kind: "tool", tool: "list", status },
    task: { kind: "tool", tool: "explore", status },
    bash: { kind: "tool", tool: "command", status },
    Bash: { kind: "tool", tool: "command", status },
    command: { kind: "tool", tool: "command", status },
  }
  if (typeof name !== "string" || !Object.hasOwn(tools, name)) return null
  const activity = tools[name]!
  // Never reinterpret a search pattern, shell command or task description as a path.
  const value = input.filePath ?? input.file_path ?? input.path
  if (typeof value !== "string") return activity
  const path = value.startsWith(`${directory}/`)
    ? value.slice(directory.length + 1)
    : value
  if (
    path.length > 0 &&
    path.length <= 200 &&
    /^[A-Za-z0-9_@./ -]+$/.test(path) &&
    !path.startsWith("/") &&
    !path
      .split("/")
      .some((segment) =>
        /^(?:\.\.?|\.env(?:\..*)?|\.git|\.claude|\.codex|\.agents)$/.test(
          segment
        )
      ) &&
    !/\.(?:pem|key|p12|pfx)$/i.test(path)
  )
    activity.path = path
  return activity
}

/** Runs beside the harness INSIDE the Sandbox. stdout contains only activity and exit status,
 * plus a short stderr tail after an abnormal exit and the per-step timeline as each step ends,
 * which orchestration logs but never displays. Logging steps as they end keeps them when the
 * run is cut short. Raw events remain in the local file for the existing final-outcome parser.
 * Once \`finalize_plan\` accepts the Dispatcher's plan, the harness is stopped: the saved draft
 * is the answer, and the model's closing message would cost another round trip. It is stopped
 * too after \`maxRejectedFinalizations\` rejected finalizations or \`maxRejectedPlanCalls\`
 * pieces that were not saved, and the saved draft is final. Repeated argument-format
 * failures pause the run earlier, allowing a bounded correction in the same session. */
export const liveHarnessActivityScript = `import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { constants } from "node:os"
import { StringDecoder } from "node:string_decoder"
const filter = ${filteredHarnessActivity.toString()}
const [events, harness, directory, command, ...args] = process.argv.slice(2)
const raw = createWriteStream(events, { mode: 0o600 })
const child = spawn(command, args, { cwd: directory, env: process.env, stdio: ["ignore", "pipe", "pipe"] })
child.stdout.pipe(raw)
let stderr = ""
child.stderr.setEncoding("utf8")
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000) })
const decoder = new StringDecoder("utf8")
let buffer = "", dropping = false, count = 0, rejected = 0, finalizeRejected = 0, stopped = null
let formatTool = "", formatFailures = 0
function emit(event) {
  if (count >= 1000) return
  const activity = filter(harness, event, directory)
  if (activity) { count++; console.log(JSON.stringify({ type: "activity", activity })) }
}
function stopAtPlanOutcome(event) {
  if (stopped || harness !== "opencode" || event.type !== "tool_use") return
  const tools = ${JSON.stringify(Object.values(planToolNames).map(planToolAgentName))}
  const finalize = ${JSON.stringify(planToolAgentName(planToolNames.finalize))}
  const state = event.part?.state ?? {}
  if (state.status !== "completed" && state.status !== "error") return
  const tool = event.part?.tool
  // OpenCode routes a call whose arguments do not parse to its \`invalid\` tool.
  const invalidTool = tool === "invalid" ? tools.find((name) => state.input?.tool === name || String(state.input?.error ?? "").includes(name)) : undefined
  const unparsed = !!invalidTool
  if (!unparsed && !tools.includes(tool)) return
  const output = typeof state.output === "string" ? state.output : ""
  if (tool === finalize) {
    if (state.status === "completed" && output.startsWith(${JSON.stringify(planAcceptedReply)})) stopped = "proposal_accepted"
    else if (++finalizeRejected >= ${maxRejectedFinalizations}) stopped = "proposal_rejected"
  } else if (unparsed || state.status === "error" || output.startsWith(${JSON.stringify(notSavedReply)})) {
    if (++rejected >= ${maxRejectedPlanCalls}) stopped = "proposal_rejected"
  }
  // Schema/JSON failures are formatting problems. Assessment failures and
  // infrastructure errors keep their existing budgets, without a format nudge.
  const format = unparsed || (output.startsWith(${JSON.stringify(notSavedReply)}) && /not valid JSON|does not match .*schema/.test(output))
  if (format) {
    const target = invalidTool ?? tool
    formatFailures = formatTool === target ? formatFailures + 1 : 1
    formatTool = target
    if (!stopped && formatFailures >= ${maxRepeatedPlanFormatFailures}) stopped = "proposal_stalled"
  } else if (tool !== ${JSON.stringify(planToolAgentName(planToolNames.inspect))}) {
    formatTool = ""
    formatFailures = 0
  }
  if (!stopped) return
  child.kill("SIGTERM")
  setTimeout(() => child.kill("SIGKILL"), 5000).unref()
}
function line(text) {
  if (text.length > 1048576) return
  let event
  try { event = JSON.parse(text) } catch { return }
  stopAtPlanOutcome(event)
  if (harness === "opencode") perfEvent(event)
  if (harness === "claude-code" && event.type === "assistant" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) emit({ type: "assistant", message: { content: [block] } })
  } else emit(event)
}
child.stdout.on("data", (chunk) => {
  buffer += decoder.write(chunk)
  let end
  while ((end = buffer.indexOf("\\n")) !== -1) {
    if (!dropping) line(buffer.slice(0, end))
    dropping = false
    buffer = buffer.slice(end + 1)
  }
  if (buffer.length > 1048576) { buffer = ""; dropping = true }
})
child.on("error", () => { process.exitCode = 1 })
child.on("close", (code, signal) => {
  buffer += decoder.end()
  if (!dropping && buffer) line(buffer)
  // A step the stop cut off still reports what it did.
  if (harness === "opencode") perfFlush()
  // A signal reads as a shell would report it, e.g. 143 for SIGTERM.
  const exitCode = stopped ? 0 : code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)
  const outcome = { type: "harness_exit", exitCode }
  if (stopped) outcome.stopped = stopped
  if (exitCode !== 0) {
    if (signal) outcome.signal = signal
    // Control characters are dropped so the line stays within the transport's limit.
    outcome.stderrTail = stderr.replace(/\\x1b\\[[0-9;]*[A-Za-z]/g, "").replace(/[\\x00-\\x08\\x0b-\\x1f\\x7f]/g, "").slice(-800)
  }
  // Flush the raw file before orchestration reads the final answer.
  const done = () => console.log(JSON.stringify(outcome))
  if (raw.writableFinished) done()
  else raw.once("finish", done)
})
raw.on("error", () => { child.kill(); process.exitCode = 1 })

${harnessTimelineScript}`
