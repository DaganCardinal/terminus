# Dispatcher conversations

> **Status:** Phase 1 is implemented: conversations, turns with read tools, planning from a conversation, revisions, all three model providers, the API and the panel. Phases 2–4 below are still to come. The decisions in [Settled decisions](#settled-decisions) were made with the maintainer on 2026-10-16; ask before changing them.

The Dispatcher is conversational. Each message you send runs a short **conversation turn** in the Worker: the Dispatcher's model reads the current state of the network, can look things up with read-only tools, and answers. When what you say calls for a plan, the turn starts the existing [planning path](dispatcher-planning.md) with a brief it wrote. Planning, proposals and launch are otherwise unchanged, and launch is always your explicit command.

## Using it

- Open **Dispatcher** on a network page. The panel opens the most recently active conversation. Pick another from the list at the top, or choose **New** to start one; a new conversation is created when you send its first message, and its first message becomes its title.
- Ask about the network ("what's blocked?", "where is the footer work?") or describe what you want built. The Dispatcher answers in seconds. While it answers, the panel shows each lookup it makes, such as "Looked up Station ‘Theme toggle’", and the composer's **Stop** stops the answer.
- A plan the Dispatcher starts appears as its card in the conversation, with the same review, baseline-fix selection, **Launch Lines** and **Stop planning** as before. Stopping a conversation turn never stops a plan it started; the plan's own Stop does.
- To change a plan, reply. A revision of a `ready` plan replaces it: the old card says **Replaced by a revised plan** and links to the revision, and the old proposal can no longer launch. There is no Refine button.
- **Check baseline first** stays in the composer and applies to the message you send with it, if that message starts a plan.
- Plans made without a conversation, including every plan from before this feature, are under **Earlier plans**. **Needs you** stays at the bottom of the panel.
- Only one message is answered at a time per conversation; the composer waits while a turn runs.

## Settled decisions

| Decision | Choice |
| --- | --- |
| Shape | Two layers: conversation turns in the Worker, and planning in a Sandbox, started by a tool call |
| Providers | Workers AI, Anthropic and OpenAI are all supported in v1 |
| Revisions | Revising a `ready` plan supersedes it; a superseded plan cannot launch |
| Escalations | Notices appear in the conversation; they never start a Dispatcher turn (Phase 2) |
| Launch | Always an explicit user command; the model can never launch |

## Two layers

| | Conversation turn | Planning |
| --- | --- | --- |
| Runs in | `DispatcherTurnWorkflow`, with a direct model call from the Worker | Dispatch Workflow, with the harness in a Sandbox (unchanged) |
| Sees | Network brief, conversation history, read tools | Checkout at the exact Terminus commit, planning context, the brief from the turn |
| Takes | Seconds | Minutes |
| Writes | Its own conversation's messages, and a plan only through `start_planning` | The plan's draft and proposal, as before |

Conversations are operational records, like plan activity. They never drive Train movement, emit no domain events, and the railway lifecycle never reads them. The only write a turn makes outside its conversation is `start_planning`, which goes through `proposeConversationPlan`, beside the existing `proposeDispatchPlan`. Model output still becomes state only after validation.

### Where the code is

| Piece | Location |
| --- | --- |
| Conversation and turn transitions (`beginTurn`, `endTurn`, `turnIsActive`), plan revision and superseding (`revisablePlan`, `supersedeDispatchPlan`) | `packages/domain/src/conversation.ts`, `dispatch-plan.ts` |
| Message, record, API and tool-argument schemas, `NetworkBrief`; Station `where` (`stationWheres`, next to `lineIdentities`) | `packages/protocol/src/conversation.ts`, `line-identity.ts` |
| `ChatModel`, its three adapters, lenient tool-argument parsing | `packages/agent-runtime/src/chat-model.ts`, `chat-adapters.ts` |
| Conversation instructions, tool definitions, history rendering, untrusted-data wrapping, `FakeDispatcherChat` | `packages/agent-runtime/src/dispatcher-conversation.ts` |
| Network brief builder | `packages/agent-runtime/src/network-brief.ts` |
| `DispatcherTurnWorkflow` and its steps | `apps/worker/src/workflows/dispatcher-turn-workflow.ts`, `conversation-operations.ts` |
| Create, send, stop and finish commands | `apps/worker/src/agents/conversations.ts` |
| Starting a conversation's plan, revisions | `proposeConversationPlan` in `apps/worker/src/agents/dispatch-planning.ts` |
| D1 store, read-tool runner | `apps/worker/src/integrations/conversation-store.ts`, `conversation-tools.ts` |
| Model resolution, ports | `resolveTurnModel`, `turnPorts`, `conversationPorts` in `apps/worker/src/agents/ports.ts` |
| Panel | `apps/web/src/views/dispatcher.tsx`, `dispatcher-conversation.tsx`, `apps/web/src/state/use-conversation.ts` |

## Conversation turns

Each accepted message starts one Workflow instance whose id is the turn id (`turn-…`):

```text
step "resolve model"        the Dispatcher role's model and reasoning level, and the provider gate
step "build brief"          the network brief, built once so every round sees the same state
loop round 0..7:
  step "respond <n>"        render the prompt from D1, call the model; nothing is written
  step "tools <n>"          save the reply, run its read tools, save their results
  step "start planning <n>" when the reply called start_planning
  after a plan starts, one more round for a closing line, then the turn ends
step "finish turn"          the conversation is idle again
on failure: step "record failure"   an error message carrying only the failure kind
```

- **One turn at a time.** The conversation record's state is `{ status: "idle" }` or `{ status: "responding", turnId, startedAt }`. A message sent while a turn runs is refused with 409.
- **Fencing.** Every message a turn writes is inserted only while the conversation still names that turn as active. A stopped turn's late writes are discarded, and the turn notices and ends.
- **Idempotent writes.** Messages are keyed `(turn_id, position)`, inserted with `INSERT OR IGNORE`, and read back. Positions come from the turn's own durable step results, so a retried step writes the same rows. The user's message is position 0; a turn's closing `stopped` or `error` message is position 9999.
- **Replies are cached by the Workflow.** The model call (`respond <n>`) is its own step, with a 5-minute timeout and one retry; saving it is the next step. A retry of the save never calls the model again.
- **Bounds.** At most 8 rounds and 6 read-tool calls per round; further calls are answered with a refusal the model can see. Each tool result is capped at 8,000 characters with a truncation note. A turn that runs out of rounds ends with `round_limit`.
- **Failures** record only a kind: `overloaded`, `configuration`, `timed_out`, `round_limit`, `refused` or `failed`. The error's message, which can carry model output or credentials, is never stored or shown. The conversation returns to idle so you can send again.
- **Stop.** `POST …/turns/:turnId/stop` saves the stop (a `stopped` message and the idle state) in one batch, then terminates the Workflow. If the Workflow cannot be terminated, fencing still discards its writes.
- **Starting the Workflow.** If the Workflow cannot be created after the message is accepted, the turn is ended with `failed`. A retried request with the same `requestId` restarts a turn whose Workflow never started.

### Model settings and the provider gate

A turn uses the Dispatcher role's **model and reasoning level** from the network's settings at that moment, so a settings change applies from the next message. The role's harness does not apply, because turns call the model directly. A turn may use an Anthropic or OpenAI model exactly when `harnessExecutionEnabled` allows that provider for the Dispatcher's harness; otherwise it ends with `configuration`. Gateway configuration is checked on each call. Each Dispatcher reply records the model, provider and reasoning level that produced it.

`DISPATCHER_MODEL=fake` selects `FakeDispatcherChat` alongside the offline planner.

## Storage

Migration `0026_dispatcher_conversations.sql` adds two tables:

- `dispatcher_conversations`: `id`, `network_id`, `record` (title, state, `lastInputTokens`), `version`, `updated_at`, and the creating `request_id`, unique so a retried create returns the same conversation. Indexed on `(network_id, updated_at)`.
- `dispatcher_messages`: `seq`, `conversation_id` (cascading delete), `turn_id`, `position`, `at`, `message`, and a unique `request_id` on user messages, so a retried send returns the original. Unique on `(turn_id, position)`; indexed on `(conversation_id, seq)`.

The migration also adds the version trigger and the `network_deleting` triggers, and a `revising` flag on `dispatch_draft_checkpoints` (see [Revisions and superseding](#revisions-and-superseding)). Deleting a network deletes its conversations and messages and its turn Workflows.

Plans need no migration: `DispatchPlan` gains optional `conversationId`, `turnId`, `request` (`{ userMessage, relatedStationIds }`) and `revises` inside its JSON record. A superseded plan is `failed` with `reason: "superseded"`, `supersededBy`, and the proposal its revision started from.

Message kinds (`dispatcherMessageSchema` in `protocol`):

| Kind | Holds | Written by |
| --- | --- | --- |
| `user` | `text` (at most 4,000 characters), `checkBaseline`, `afterEventSeq` | The API, when it accepts the message |
| `dispatcher` | Reply `text`, its `toolCalls`, model provenance | The turn |
| `tool` | `callId`, tool name, `arguments`, capped and labelled `result`, `fetchedAt` | The turn |
| `plan` | `planId`, `revisesPlanId?` | The turn's `start planning` step |
| `stopped`, `error` | Error kind (`error` only) | The API (`stopped`), the turn (`error`) |

`afterEventSeq` is the network's latest event seq when the message was accepted; Phase 2 uses it to place notices. Provider reasoning and provider-specific state are never stored in D1: they live only in the turn's Workflow step results and are replayed only within that turn.

## Building the prompt

The order is chosen for prompt caching, which only reuses the unchanged start of a prompt:

1. **System:** the conversation instructions and the untrusted-data rules, plus the tool definitions in a fixed order. Identical for every turn of every conversation.
2. **History:** earlier turns, rendered from D1 in their final form.
3. **This turn:** the network brief inside a random-boundary `<network-state as-of="…">` block, then your message. Each round only appends the reply and the tool results.

Earlier turns render the same way on every later turn: their brief becomes a stub (`[network state as of 2026-10-16T14:02Z omitted]`) and they carry no provider reasoning. So everything before the current turn stays byte-identical. A turn that ended early gets a closing note in the history, and each tool call it left unanswered gets a placeholder result, so every provider accepts the history. The last message of the previous turn is marked as the cache breakpoint.

The brief, tool results and earlier conversations contain text written by users and models, such as goals, manifests and review feedback. Each is enclosed in a tag with a random `boundary` value, chosen after the content exists, and the instructions treat everything inside as information, never instructions.

## The network brief

Built by `buildNetworkBrief` from the snapshot at the start of each turn, as compact JSON (`NetworkBrief` in `protocol`):

```text
network        name, terminusCommit, asOf
attention      blocked Trains with issues, open conflicts, conflict reports, Engineer notices,
               Trains awaiting approval, repairs awaiting approval
liveLines      id, name, number and color as the map shows them, destination, unloadMode,
               train { id, status, where it is, holds, cars }
               stations: id, name, status, where, goal (first line), expectedAreas,
                         contract names, dependencies
recentPlans    id, goal (first 120 characters), status, lineIds, conversationId    last 10
finishedLines  name, outcome, finishedAt, Station names                           last 30, older counted
```

`where` says where a Station's work actually is. `stationWheres` computes it in one place, next to `lineIdentities`, and `planningContext` uses the same finished-Line rule (`finishedLineOutcome`):

| `where` | Station state |
| --- | --- |
| `waiting` | `waiting` |
| `in_progress` | `signaled`, `active`, `ready_for_pickup`, `in_review` or `revising` |
| `blocked` | `blocked` |
| `on_train` | `complete`, and its Line is still live: accepted onto a Train or into a Junction, not yet in Terminus |
| `in_terminus` | `complete`, and its Line finished `integrated` |
| `abandoned` | Anything but `cancelled`, and its Line finished `abandoned` |
| `cancelled` | `cancelled` |

The brief aims at 3,000–5,000 tokens (20,000 characters). Over that, live Lines that need no attention shrink to a count, largest first (`2 Stations: 1 on_train, 1 waiting`), keeping their id, name, number and colour, and their details stay one tool call away.

## Tools

### Read tools

Read tools take only ids and search text. The network always comes from the turn, never from the arguments, so an id from another network is not found. Arguments are parsed leniently (JSON sent as text is accepted) and then checked against the tool's schema; a bad call becomes an ordinary tool reply the model can correct.

| Tool | Returns |
| --- | --- |
| `terminus_station(stationId)` | The full Work Manifest, state, revision and retry counts, latest Conductor review, Cars with accepted commits and check results, and `where` |
| `terminus_line(lineId)` | Map number and colour while live, route and stops, Train state, holds, Cars, Crossings, Junction membership, unload policy |
| `terminus_plan(planId)` | Goal, request, status, a proposal summary with its Lines and Stations, findings, assessment, revision chain |
| `terminus_activity(entityId, limit?)` | Recent events for a Train, Station or plan, newest first (20 by default, at most 50) |
| `terminus_search(query)` | Matches across Station names and goals, plan goals, conversation titles and user messages, grouped by kind, at most 20. Uses `LIKE` |
| `terminus_conversation(conversationId, before?)` | A conversation's user and Dispatcher messages and plan references, newest first, 20 per page; never tool messages |

### `start_planning`

The only action tool:

```text
start_planning({ brief, relatedStationIds?, revisesPlanId? })
```

- **`brief`** (at most 4,000 characters) says what the planner should achieve. It becomes the plan's `goal`, so existing plan views keep working.
- **One plan at a time.** The call is refused while any plan on the network is `planning`.
- **`checkBaseline`** comes from your message, never from the model.
- **The plan id** is derived from the turn id and the call's position, so a retried step finds the plan it already created.
- **`revisesPlanId`** must name a plan in this conversation that is `ready` or `failed` (which includes stopped plans) and not already superseded. A `planning`, `launching`, `starting` or `launched` plan is refused, and the reply tells the model to plan follow-up work against the existing Lines instead.
- **After a plan starts**, one more model round writes a closing line; any tool calls in it are dropped. Then the turn ends. A refused call is answered like any tool, and the turn continues.

Tool calls are never forced, since some current models reject a forced tool choice. The instructions say when to plan.

## Handing off to planning

The new plan records `conversationId`, `turnId`, `request: { userMessage, relatedStationIds }`, and `revises` for a revision. The planner's first message holds the brief, your latest message word for word, and the related Station ids, all labelled as an untrusted request, as goals always were. The planner does not receive the conversation itself.

### Revisions and superseding

- **Superseding:** when the revised plan is `ready`, it is superseded (`dispatcher.plan_superseded`) in the same D1 batch that creates the revision, so the old proposal cannot launch in between; the existing refusal to launch a failed plan covers it after that. If the old plan changed concurrently (it launched, or another revision won), the batch fails and the call is re-checked. Superseding follows one revision chain; two separate plans in one conversation can both be `ready`.
- **With plan tools (OpenCode):** the revised plan's `dispatch_drafts` rows are copied into the new plan in that same batch. The preparation checkpoint is not copied, because Terminus may have moved: the baseline is prepared again, and a plan's first checkpoint keeps the draft it was given. The planner is told the draft is the revised plan's and checks it against the current network.
- **A revision is finished only when `terminus_finalize_plan` accepts it.** Its copied draft can pass every check before the planner changes anything, so the revision's checkpoint is `revising` until then. While it is, neither a harness failure nor a retry's checkpoint returns the draft as the answer: the failure goes to the durable retry, and the retry starts a session that continues the revision from what was saved. A session that ends without acceptance gets the usual corrections, then the plan fails rather than returning the revised plan unchanged.
- **Other harnesses:** the revised plan's proposal goes into the planner's first message as untrusted data. A superseded plan keeps its proposal for this.

Nothing is posted into the conversation when a plan becomes ready. The `plan` message renders the plan's live card from the snapshot, and the next turn sees the plan's status in `recentPlans`.

## Model adapters

`ChatModel.respond({ system, messages, tools, maxOutputTokens, cacheKey })` returns `{ text?, toolCalls, finish: "stop" | "tool_calls" | "length" | "refused", usage, providerState? }`. `cacheKey` is the conversation id. Each adapter takes an injected transport, as `GatewayModelProvider` does, so tests need no network, and reports a failed call by its HTTP status only.

| | Workers AI | Anthropic | OpenAI |
| --- | --- | --- | --- |
| API | Chat completions at `/client/v4/accounts/<account>/ai/v1/chat/completions` | Messages, through AI Gateway at `/anthropic/v1/messages` | Responses, through AI Gateway at `/openai/responses` |
| Auth | Bearer runtime token and `cf-aig-gateway-id` | `cf-aig-authorization` (Unified Billing, no provider key) and `anthropic-version: 2023-06-01` | `cf-aig-authorization` |
| Caching | `x-session-affinity: <conversationId>` | `cache_control` on the system block and on the last block of the previous turn, plus top-level automatic `cache_control` for this turn's rounds | Automatic prefix caching, plus `prompt_cache_key: <conversationId>` |
| Reasoning | `reasoning_effort` | Adaptive thinking with `output_config: { effort }`; neither for models whose catalog entry lists no levels (Haiku 4.5) | `reasoning: { effort }` |
| Within a turn | Nothing extra | The reply's content blocks, thinking included, go back unchanged in later rounds | `store: false` and `include: ["reasoning.encrypted_content"]`; reasoning items go back in later rounds |
| Refusal | `finish_reason: "content_filter"` | `stop_reason: "refusal"` | A `refusal` content part, or `content_filter` |

These rules apply to all three:

- **Only Terminus' own tools.** Only Terminus' function tools are declared, never provider-hosted tools, and no tool choice is forced.
- **No provider-side state.** OpenAI runs with `store: false`, so D1 holds the only copy of a conversation.
- **Reasoning never leaves its turn.** It is sent back only within the turn that produced it, and earlier turns render without it. Thinking blocks are therefore only ever dropped from the start of the history, never edited, which keeps Anthropic's thinking checks satisfied.
- **No automatic fallback.** A refusal ends the turn with `refused`; server-side refusal fallbacks are not used, because Terminus never switches models automatically.
- **Token counts.** Each reply's input token count, cached and uncached together, is saved on the conversation as `lastInputTokens`, for the Phase 2 compaction check.

## API

All routes are under `/api/networks/:networkId`, check that the conversation belongs to the network (404 otherwise), and return `Cache-Control: no-store`.

| Route | Does |
| --- | --- |
| `POST /conversations` `{ requestId }` | Creates a conversation, idempotently by `requestId`. Returns 201 with `{ id, title, state, turnId?, updatedAt, planIds }` |
| `GET /conversations` | `{ conversations: [...] }`, most recently active first |
| `POST /conversations/:conversationId/messages` `{ requestId, text, checkBaseline? }` | Accepts a message and starts a turn. Returns 202 with `{ turnId, message }`, or 409 while a turn is running. Reusing a `requestId` with the same text returns the original; with different text, 409 |
| `GET /conversations/:conversationId/messages?after=<seq>` | `{ conversation, messages, lastSeq, hasMore }`, at most 100 messages per page |
| `POST /conversations/:conversationId/turns/:turnId/stop` | Stops a running turn and returns the conversation. 409 if that turn is not running |

`POST /plans` stays for API clients and the offline demos. It creates a plan without a conversation.

```bash
curl -X POST http://localhost:8787/api/networks/NETWORK_ID/conversations \
  -H 'content-type: application/json' \
  -d '{"requestId":"6f1c2c3e-0b7a-4c1e-9a55-3f2b8f0d9a10"}'
curl -X POST http://localhost:8787/api/networks/NETWORK_ID/conversations/CONVERSATION_ID/messages \
  -H 'content-type: application/json' \
  -d '{"requestId":"0d3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b","text":"Add a dark mode toggle"}'
curl 'http://localhost:8787/api/networks/NETWORK_ID/conversations/CONVERSATION_ID/messages?after=0'
```

The panel polls the messages endpoint only while the panel and page are visible: every second while a turn runs, every five seconds otherwise.

## Offline and testing

- **Offline chat.** `FakeDispatcherChat` keeps `dev:fake` and the tests offline. It calls `start_planning` when a message reads like a goal (revising this conversation's latest ready or failed plan, if any), and otherwise answers with counts from the brief.
- **Tests without a model** cover turn transitions and fencing, `where`, the brief and its budget, history rendering, superseding and revision rules, draft copying, the tool runner's network scoping, the turn's tool bounds and failure kinds, and the API end to end with real Workflows.
- **Adapter tests** check each adapter against recorded request and response shapes, including tool rounds, reasoning replay and refusals. No test calls a provider.
- **Live checks.** Live development uses GLM. Live checks of the Anthropic and OpenAI adapters need the maintainer's explicit go-ahead and are part of the [release checklist](harness-selection.md#release-verification); they have not been run yet.
- **Workflow binding.** `DISPATCHER_TURN_WORKFLOW` is in `wrangler.jsonc` (both environments) and was added to `worker-configuration.d.ts` by hand. Don't regenerate that file with `cf-typegen`: it replaces the typed Workflow and Durable Object bindings with untyped ones.

## Phases

1. **Conversations (done):** migration `0026`, the conversation domain and store, `DispatcherTurnWorkflow`, `ChatModel` with all three adapters, the network brief and `where`, the read tools, `start_planning` with revisions and superseding, the API, the panel and `FakeDispatcherChat`.
2. **Notices and long conversations:**
   - **Notices**, derived from the event log when read, never stored: `dispatcher.user_attention_requested`, `dispatcher.engineer_notice_raised`, `dispatcher.conflict_reported` and `dispatcher.junction_attention_requested`. A notice belongs to the conversation holding the most recent user message accepted before it (the largest `afterEventSeq` below the event's seq), and sits before the first user message at or after it. Notices from before the network's first conversation appear only under **Needs you**. They never start a turn.
   - **Compaction**, in a "prepare history" step: when `lastInputTokens` is above 60% of the model's context window (a new `contextTokens` field on `MODEL_CATALOG`), the Dispatcher model summarizes everything except the last three turns into a `compaction` message, and the prompt starts there.
   - **Tool-result clearing**: once results older than the last two turns exceed about 20,000 tokens, all of them are replaced at once with stubs.
   - **Past conversations in the brief** (id, title, last activity, plans), built without model calls.
3. **Tools for the planner:** the read tools served to the planning Sandbox through `plan-tools.ts`, and `promptNetwork` no longer sending live manifests twice.
4. **Actions:** hold, remove Station and stop, proposed by the Dispatcher as commands you confirm with a button.

## Later

- A read-only `investigate` tool for code questions ("is this already implemented?"), which runs a short harness session without planning.
- Streamed replies.
- Model-written titles, and summaries of conversations that were never compacted.
- FTS5 search, if `LIKE` is not enough.

## Implementation review findings — 2026-10-16

These four findings came from the review of the uncommitted Phase 1 implementation. Type checking and 106 existing focused tests passed. Four temporary offline regression checks reproduced the failures described below; those checks were removed after the review. No live provider calls were made, and the review did not change the implementation.

A second review confirmed all four against the code. Findings 1 and 2 are fixed, with regression tests that fail on the earlier code; 3 and 4 are still open.

### 1. [P1, fixed] Limit caching to the last previous turn

**Fixed:** `conversationMessages` marks only the last message of the whole history. A test in `chat-adapters.test.ts` sends conversations with 0 to 8 previous turns through the Anthropic adapter and checks that every request carries at most three `cache_control` fields.

**Location:** `conversationMessages` in `packages/agent-runtime/src/dispatcher-conversation.ts`, with request construction in `packages/agent-runtime/src/chat-adapters.ts`.

The history renderer marks the last message of **every** previous turn with `cacheBreakpoint`. The Anthropic adapter adds a system breakpoint and top-level automatic caching. On the fourth user message, the request therefore contains three history breakpoints plus the system and automatic breakpoints: five in total. Anthropic permits four slots and rejects a request that has four explicit breakpoints plus automatic caching. Subsequent messages in the same conversation continue to exceed the limit. See [Anthropic's caching limits](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#combining-with-block-level-caching).

**Reproduction:** Render three completed user/Dispatcher exchanges followed by a fourth user message, then capture the Anthropic request through an injected transport. The generated request contains five `cache_control` fields. This verifies the invalid request shape without calling the provider.

**Suggested fix:** Apply the history breakpoint once, after rendering all previous turns, to the last message of the complete history. Add a regression test that builds requests for several conversation lengths and verifies that the total stays within the provider's limit.

### 2. [P1, fixed] Distinguish a revision seed from completed planning

**Fixed:** see [Revisions and superseding](#revisions-and-superseding). `dispatch_draft_checkpoints.revising` is set when the revision is created, survives preparation's checkpoint, and is cleared by the plan-tools handler when `terminus_finalize_plan` accepts the plan. Tests cover a startup failure, a retry after preparation, an accepted revision that fails afterwards, and a session that never finishes, in `dispatcher-agent.test.ts`, plus the whole failure and retry against D1 in `conversation-plans.test.ts`.

**Location:** Revision draft handling and recovery in `HarnessDispatcher.plan` in `packages/agent-runtime/src/dispatcher-agent.ts`; checkpoint handling in `apps/worker/src/integrations/dispatch-draft-store.ts`.

A revision starts with a copied draft that may already pass every structural and network check. The existing harness-error recovery treats any valid saved draft as a completed answer. If `session.start` fails before the planner does any work, it can therefore return the unchanged original proposal as the successful revision. The original plan has already been superseded, while the replacement silently ignores the requested change.

Checkpoint recovery has the same exposure: preparation replaces the revision-seed marker with a normal checkpoint before the planner finishes. An interrupted attempt can subsequently restore that untouched valid draft and return it without starting the harness.

**Reproduction:** Seed a valid footer draft, request that the revision replace it with a header, and make `session.start` throw a harness-startup error. The call resolves successfully with the unchanged footer proposal instead of propagating the failure for retry.

**Suggested fix:** Persist whether the revision has actually completed planning, separately from whether its copied draft passes validation. Require that completion evidence before either error recovery or checkpoint recovery can return the proposal. Add regression tests for startup failure and interruption after preparation but before revision completion.

### 3. [P2] Persist the plan reference atomically with creation

**Location:** `startTurnPlanning` in `apps/worker/src/workflows/conversation-operations.ts`, together with plan-card rendering in `apps/web/src/views/dispatcher-conversation.tsx` and `apps/web/src/views/dispatcher.tsx`.

Plan creation and insertion of the conversation's `plan` message happen separately. If the user stops the turn after `startPlanning` creates its plan but before the message append, the append is fenced out. The plan continues running, as intended for an already-started plan, but its card is permanently missing from the panel. `ConversationThread` renders cards only from plan messages, and **Earlier plans** excludes every plan with a `conversationId`. The user consequently loses the card's review, stop and launch controls.

**Reproduction:** Start a real persisted plan through `proposeConversationPlan`, stop the turn before returning from the injected `startPlanning` callback, then allow `startTurnPlanning` to continue. The plan remains in the snapshot, but no `plan` message exists in the conversation.

**Suggested fix:** Save the conversation's plan reference atomically with plan creation, or recover missing cards from the conversation's persisted plans. Preserve the rule that stopping an answer does not stop a plan it already started. Add a regression test for stopping between plan creation and saving its tool reply.

**Also found:** while the plan with no card is `planning`, it refuses `start_planning` in every conversation on the network. Later turns' history also answers its `start_planning` call with "[not run: the turn ended first]", while `recentPlans` lists the plan.

### 4. [P2] Enforce the planning limit atomically

**Location:** `proposeConversationPlan` in `apps/worker/src/agents/dispatch-planning.ts`.

The network-wide one-plan-at-a-time check reads a snapshot before a separate plan insertion. Two turns in different conversations can both observe that no plan is being prepared, then each create a different plan and start its planning Workflow. The per-conversation active-turn fence does not serialize these calls across the network.

**Reproduction:** Run two `proposeConversationPlan` calls with different plan and conversation identities, using a barrier to let both snapshot reads finish before either call proceeds. Both calls succeed and persist a planning plan; the expected outcome is one successful creation and one refusal.

**Suggested fix:** Enforce the network-wide planning condition atomically with insertion, using a database constraint or transactional guard that also handles competing plan-creation paths. Keep retries of the same plan id idempotent. Add a concurrent regression test rather than relying only on sequential refusal tests.

**Priority:** the second review lowers this to P3. The race needs two conversations to call `start_planning` within the same fraction of a second, and two plans preparing at once is a state Terminus already supports: `POST /plans` (`proposeDispatchPlan`) has no limit, each plan has its own Sandbox, and launch reassesses against the live network. A database constraint would also start refusing `POST /plans`, so decide first whether the rule covers every way of creating a plan.
