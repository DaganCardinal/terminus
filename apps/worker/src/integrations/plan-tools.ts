import {
  planToolNames,
  planToolReply,
  planToolServer,
  planTools,
} from "@terminus/agent-runtime"
import type { PlanDraft, SandboxNetwork } from "@terminus/protocol"
import type { DispatchDraftStore } from "./dispatch-draft-store"

type PlanCheck = NonNullable<SandboxNetwork["proposalCheck"]>
type Drafts = Pick<DispatchDraftStore, "read" | "save">

const toolNames: readonly string[] = Object.values(planToolNames)

/**
 * Serves the Dispatcher's plan tools to its Sandbox as a minimal remote MCP
 * server: Streamable HTTP with plain JSON replies, and no sessions or
 * server-sent streams. It runs inside the outbound handler, so it sees only
 * the plan and planning context orchestration granted this Sandbox. Each call
 * reads the plan's draft, answers it, and saves the piece it changed.
 */
export async function planToolResponse(
  request: Request,
  check: PlanCheck,
  /** The Sandbox's model takes the outline as JSON text (`proposalAsText`). */
  asText: boolean,
  drafts: Drafts
): Promise<Response> {
  // The client may open a server-sent stream; this server never pushes.
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } })
  const message: unknown = await request.json().catch(() => undefined)
  if (!isRecord(message) || typeof message.method !== "string")
    return rpcError(null, -32600, "Invalid request")
  // Notifications carry no id and get no reply.
  const id = message.id
  if (typeof id !== "string" && typeof id !== "number")
    return new Response(null, { status: 202 })
  const params = isRecord(message.params) ? message.params : {}
  switch (message.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion:
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: planToolServer.name, version: "2.0.0" },
      })
    case "ping":
      return rpcResult(id, {})
    case "tools/list":
      return rpcResult(id, { tools: planTools(asText) })
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : ""
      if (!toolNames.includes(name)) return rpcError(id, -32602, "Unknown tool")
      let draft: PlanDraft
      try {
        draft = await drafts.read(check.planId)
      } catch {
        return toolError(id, "Terminus could not read the saved plan.")
      }
      const reply = planToolReply(name, params.arguments, draft, check)
      try {
        await drafts.save(check.planId, draft, reply.draft)
      } catch {
        return toolError(id, "Terminus could not save this call.")
      }
      // Not an MCP error: a rejected piece is an ordinary answer the agent acts on.
      return rpcResult(id, { content: [{ type: "text", text: reply.text }] })
    }
    default:
      return rpcError(id, -32601, "Method not found")
  }
}

/** An infrastructure failure the agent can retry; nothing was saved. */
function toolError(id: string | number, text: string): Response {
  return rpcResult(id, {
    content: [{ type: "text", text: `${text} Try the same call again.` }],
    isError: true,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function rpcResult(id: string | number, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result })
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string
): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } })
}
