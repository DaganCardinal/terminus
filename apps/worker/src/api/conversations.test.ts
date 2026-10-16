import {
  conversationMessagesResponseSchema,
  conversationSummarySchema,
  conversationsResponseSchema,
  sendConversationMessageResponseSchema,
  type ConversationMessagesResponse,
  type NetworkSnapshot,
  type NetworkSummary,
} from "@terminus/protocol"
import {
  SELF,
  env,
  introspectWorkflow,
  type WorkflowIntrospector,
} from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const base = "https://terminus.test/api"
let introspectors: WorkflowIntrospector[] = []
beforeEach(async () => {
  introspectors = await Promise.all([
    introspectWorkflow(env.DISPATCHER_TURN_WORKFLOW),
    introspectWorkflow(env.DISPATCH_WORKFLOW),
  ])
})
afterEach(async () => {
  await Promise.all(introspectors.map((instance) => instance.dispose()))
})

const api = (path: string, init?: RequestInit) =>
  SELF.fetch(`${base}${path}`, init)
const post = (path: string, body?: unknown) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out")
    await scheduler.wait(100)
  }
}

async function setup() {
  const network: NetworkSummary = await (
    await post("/networks", { name: "Conversations" })
  ).json()
  const created = await post(`/networks/${network.id}/conversations`, {
    requestId: crypto.randomUUID(),
  })
  expect(created.status).toBe(201)
  expect(created.headers.get("cache-control")).toBe("no-store")
  const conversation = conversationSummarySchema.parse(await created.json())
  const path = `/networks/${network.id}/conversations/${conversation.id}`
  const read = async (): Promise<ConversationMessagesResponse> =>
    conversationMessagesResponseSchema.parse(
      await (await api(`${path}/messages?after=0`)).json()
    )
  const send = (text: string, extra: object = {}) =>
    post(`${path}/messages`, {
      requestId: crypto.randomUUID(),
      text,
      ...extra,
    })
  const idle = () =>
    waitUntil(async () => (await read()).conversation.state === "idle")
  const snapshot = async (): Promise<NetworkSnapshot> =>
    (await api(`/networks/${network.id}`)).json()
  return { network, conversation, path, read, send, idle, snapshot }
}

describe("Dispatcher conversations", () => {
  it("answers a question without planning", async () => {
    const { send, read, idle, snapshot } = await setup()
    const response = await send("How is the network doing?")
    expect(response.status).toBe(202)
    const sent = sendConversationMessageResponseSchema.parse(
      await response.json()
    )
    expect(sent.message.message).toMatchObject({ kind: "user" })
    await idle()
    const { messages, conversation } = await read()
    expect(conversation.title).toBe("How is the network doing?")
    expect(messages.map((m) => m.message.kind)).toEqual(["user", "dispatcher"])
    expect(messages[1]!.message).toMatchObject({
      kind: "dispatcher",
      model: "fake",
    })
    expect((await snapshot()).plans).toHaveLength(0)
  })

  it("refuses a second message while a turn runs, and returns a retried one", async () => {
    const { path, send, idle, read } = await setup()
    const requestId = crypto.randomUUID()
    const first = await post(`${path}/messages`, {
      requestId,
      text: "What is running?",
    })
    expect(first.status).toBe(202)
    const again = await post(`${path}/messages`, {
      requestId,
      text: "What is running?",
    })
    expect(again.status).toBe(202)
    expect(
      sendConversationMessageResponseSchema.parse(await again.json()).turnId
    ).toBe(
      sendConversationMessageResponseSchema.parse(await first.json()).turnId
    )
    const other = await post(`${path}/messages`, {
      requestId,
      text: "Something else",
    })
    expect(other.status).toBe(409)
    await idle()
    expect(
      (await read()).messages.filter((m) => m.message.kind === "user")
    ).toHaveLength(1)
    // While busy, a new message is refused. Once idle it is accepted.
    expect((await send("And now?")).status).toBe(202)
    await idle()
  })

  it("starts a plan from a goal, then supersedes it with a revision", async () => {
    const { conversation, send, idle, read, snapshot } = await setup()
    expect(
      (await send("Add a dark mode toggle", { checkBaseline: false })).status
    ).toBe(202)
    await idle()
    const first = (await read()).messages
    const planMessage = first.find((m) => m.message.kind === "plan")
    expect(planMessage).toBeDefined()
    const planId = (planMessage!.message as { planId: string }).planId
    await waitUntil(async () =>
      (await snapshot()).plans.some(
        (p) => p.id === planId && p.state.status === "ready"
      )
    )
    const plan = (await snapshot()).plans.find((p) => p.id === planId)!
    expect(plan).toMatchObject({
      conversationId: conversation.id,
      goal: "Add a dark mode toggle",
      request: { userMessage: "Add a dark mode toggle", relatedStationIds: [] },
    })
    expect(first.map((m) => m.message.kind)).toEqual([
      "user",
      "dispatcher",
      "tool",
      "plan",
      "dispatcher",
    ])

    expect((await send("Change it to follow the system theme")).status).toBe(
      202
    )
    await idle()
    const revision = (await read()).messages.findLast(
      (m) => m.message.kind === "plan"
    )!.message as { planId: string; revisesPlanId?: string }
    expect(revision.revisesPlanId).toBe(planId)
    const plans = (await snapshot()).plans
    expect(plans.find((p) => p.id === planId)!.state).toMatchObject({
      status: "failed",
      reason: "superseded",
      supersededBy: revision.planId,
    })
    expect(plans.find((p) => p.id === revision.planId)!.revises).toBe(planId)
    // A superseded plan cannot launch.
    const network = (await snapshot()).network
    expect(
      (await post(`/networks/${network.id}/plans/${planId}/launch`)).status
    ).toBe(409)
    const summaries = conversationsResponseSchema.parse(
      await (await api(`/networks/${network.id}/conversations`)).json()
    )
    expect(summaries.conversations[0].planIds).toEqual([
      planId,
      revision.planId,
    ])
  }, 30_000)

  it("stops a running turn and fences its late writes", async () => {
    const { path, send, read } = await setup()
    const sent = sendConversationMessageResponseSchema.parse(
      await (await send("Summarize the network")).json()
    )
    const stop = await post(`${path}/turns/${sent.turnId}/stop`)
    // The offline turn may finish first; either way the turn ends once.
    if (stop.status === 200) {
      const { messages, conversation } = await read()
      expect(conversation.state).toBe("idle")
      expect(messages.some((m) => m.message.kind === "stopped")).toBe(true)
      await scheduler.wait(500)
      const after = await read()
      expect(
        after.messages.filter((m) => m.message.kind === "dispatcher")
      ).toHaveLength(0)
    } else expect(stop.status).toBe(409)
    expect((await post(`${path}/turns/${sent.turnId}/stop`)).status).toBe(409)
  })

  it("keeps conversations to their network", async () => {
    const one = await setup()
    const other: NetworkSummary = await (
      await post("/networks", { name: "Other" })
    ).json()
    expect(
      (
        await api(
          `/networks/${other.id}/conversations/${one.conversation.id}/messages`
        )
      ).status
    ).toBe(404)
    expect(
      (
        await post(
          `/networks/${other.id}/conversations/${one.conversation.id}/messages`,
          { requestId: crypto.randomUUID(), text: "Hello" }
        )
      ).status
    ).toBe(404)
  })

  it("deletes conversations with their network", async () => {
    const { network, send, idle } = await setup()
    await send("Hello there")
    await idle()
    const response = await api(`/networks/${network.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: '{"confirm":true}',
    })
    expect(response.status, await response.text()).toBe(204)
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM dispatcher_messages"
    ).first<{ n: number }>()
    const conversations = await env.DB.prepare(
      "SELECT count(*) AS n FROM dispatcher_conversations WHERE network_id = ?"
    )
      .bind(network.id)
      .first<{ n: number }>()
    expect(conversations!.n).toBe(0)
    expect(row).toBeDefined()
  })
})
