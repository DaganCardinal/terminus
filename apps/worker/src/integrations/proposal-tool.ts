import {
  proposalSubmissionReply,
  proposalSubmissionTool,
  proposalTool,
} from "@terminus/agent-runtime"
import { perf, type SandboxNetwork } from "@terminus/protocol"

type ProposalCheck = NonNullable<SandboxNetwork["proposalCheck"]>

/**
 * Serves the Dispatcher's proposal tool to its Sandbox as a minimal remote
 * MCP server: Streamable HTTP with plain JSON replies, and no sessions or
 * server-sent streams. It runs inside the outbound handler, so it sees only
 * the planning context orchestration granted this Sandbox.
 */
export async function proposalToolResponse(
  request: Request,
  check: ProposalCheck,
  /** The Sandbox's model takes the proposal as JSON text (`proposalAsText`). */
  asText: boolean
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
        serverInfo: { name: proposalTool.server, version: "1.0.0" },
      })
    case "ping":
      return rpcResult(id, {})
    case "tools/list":
      return rpcResult(id, { tools: [proposalSubmissionTool(asText)] })
    case "tools/call": {
      if (params.name !== proposalTool.name)
        return rpcError(id, -32602, "Unknown tool")
      const reply = proposalSubmissionReply(
        params.arguments,
        check.network,
        check.baseline
      )
      perf("dispatcher.proposal_tool", { accepted: reply.accepted })
      // Not an MCP error: a rejected proposal is an ordinary answer the
      // agent acts on, and the submission is still recorded.
      return rpcResult(id, { content: [{ type: "text", text: reply.text }] })
    }
    default:
      return rpcError(id, -32601, "Method not found")
  }
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
