# Dispatcher conversations

## Context

The Dispatcher panel renders every plan a Network has ever had as one endless thread (`snapshot.plans`), and every snapshot ships every plan with its full proposal (up to 24 manifests each). The model's own context does **not** grow: each plan is a fresh one-shot harness session given only the goal plus the bounded `promptNetwork` summary. The real problems are:

1. **Unbounded UI and payload.** The thread and the snapshot grow with history.
2. **No continuity.** "Revising" only refills the composer, so a follow-up plan never sees the previous proposal or why it was rejected.

Conversations fix both. **New conversation** gives a clean slate, a switcher lets the user move between conversations, and within one conversation the Dispatcher gets a compact, deterministic brief of the earlier turns. No summarizer agent: the brief is built from stored plan records. Proposal `summary` and `findings` are already model-written, bounded summaries, and canonical network state already carries memory across sessions.

## Decisions (defaults; change at approval if wanted)

- **Lazy creation:** a conversation is created with its first plan, so empty conversations never exist.
- **One `planning` plan per conversation (409 otherwise):** other conversations can still plan in parallel.
- **`plans` is removed from `NetworkSnapshot` and replaced by conversation summaries.** Full plans come from a per-conversation endpoint.
- **Archive only, no rename:** titles come from the first goal.
- **Selected conversation is UI state:** in memory plus per-network `localStorage` (try/catch), defaulting to the most recently active non-archived conversation.

---

## Slice 1: Data model

**Migration `apps/worker/migrations/0021_dispatch_conversations.sql`**
- `dispatch_conversations(id PK, network_id FK, title, created_at, archived_at NULL, version)` with an index on `(network_id, created_at)`.
- `ALTER TABLE dispatch_plans ADD COLUMN conversation_id TEXT REFERENCES dispatch_conversations(id)`, plus an index on it.
- **Backfill:** one `'conversation-' || network_id` row titled "Earlier planning" per network with plans. Then `UPDATE dispatch_plans SET conversation_id = …, record = json_set(record,'$.conversationId',…), version = version + 1`. The bump is required because the `dispatch_version` trigger in `0004` rejects updates without it. Exclude networks with `deleting = 1`, whose triggers in `0015` would abort the migration.
- **Deletion triggers** on `dispatch_conversations` (insert and update), copying the `0015_network_deletion.sql` pattern.
- **`BEFORE INSERT` trigger on `dispatch_plans`:** aborts `conversation_mismatch` when `conversation_id` is null or belongs to another network. `ALTER` cannot add `NOT NULL`.

**Domain**: `packages/domain/src/dispatch-plan.ts`, or a new `dispatch-conversation.ts` exported from the index:
- `DispatchConversation { id, networkId, title, createdAt, archivedAt? }`.
- `startConversation({ id, networkId, goal, createdAt })`: title is the first line of the goal, trimmed to 80 characters; emits `dispatcher.conversation_started { conversationId }`.
- `archiveConversation(c, at)`: emits `dispatcher.conversation_archived`; idempotent, so archiving again emits no event.
- `DispatchPlan.conversationId: string` is required; `createDispatchPlan` rejects plans without one.
- Add the 2 events to `packages/domain/src/events.ts`, `packages/protocol/src/events.ts`, `apps/web/src/views/event-presentation.ts` (`routine(Info)`) and `apps/web/src/views/describe.ts`.

**Protocol** (`packages/protocol/src/dispatch.ts`, `api.ts`):
- `dispatchPlanSchema` gains `conversationId: z.string()`.
- `createDispatchPlanRequestSchema` gains an optional `conversationId`.
- New `dispatchConversationSummarySchema` containing `{ id, title, createdAt, archivedAt?, revision, planCount, latest: { planId, status, goal, createdAt } | null, active: { planId, status }[] }`.
- New `updateDispatchConversationRequestSchema` (`{ archived: boolean }`).

**Store** (`apps/worker/src/integrations/network-store.ts`):
- New `Write` kind `{ kind: "dispatch_conversation"; conversation; version: number | null }`, written in the `writeStatement` switch next to the `dispatch_plan` case (~line 1812).
- The `dispatch_plan` insert also sets the `conversation_id` column.
- New `conversation(id)`, `conversationPlans(id)` (ordered by `createdAt`, then `id`, parsed with `dispatchPlanSchema`) and `conversationSummaries(networkId)`.
- `revision = COUNT(p.id) + SUM(p.version)` changes on every plan insert or update with no extra write; the web uses it as a cache key.
- `plansAwaitingLaunch` (~line 1236) counts non-archived conversations whose latest plan is `ready`.

**Deletion**: in `apps/worker/src/integrations/network-deletion-store.ts` `erase()`, add `"dispatch_conversations"` after `"dispatch_plans"` (children first).

## Slice 2: API, snapshot and UI

**Planning command**: `proposeDispatchPlan` in `apps/worker/src/agents/dispatch-planning.ts`.
- **No `conversationId`:** create the conversation `conversation-<requestId hex>` with `startConversation`, in the same `store.commit` batch as the plan, so a retried request reuses it.
- **With `conversationId`:** 404 if unknown or another network's, 409 if archived, 409 if one of its plans is `planning`.
- **Idempotency:** the existing request-identity check also compares `conversationId`.
- `archiveDispatchConversation(ports, networkId, conversationId)`: archives the conversation in a versioned write.

**Routes** (`apps/worker/src/api/router.ts`, following the `/plans/:planId/activity` pattern):
- `GET /api/networks/:networkId/conversations`: summaries.
- `GET /api/networks/:networkId/conversations/:conversationId/plans`: full plans, `cache-control: no-store`, 404 for a different network.
- `PATCH /api/networks/:networkId/conversations/:conversationId`: body is `updateDispatchConversationRequestSchema`.

**Snapshot**: in `NetworkSnapshot` (`packages/protocol/src/api.ts:158`), replace `plans` with `conversations: DispatchConversationSummary[]`, and update `snapshot()` in network-store (~line 1623/1681) to match.

**Web**:
- `apps/web/src/state/api.ts`: `conversations`, `conversationPlans` and `archiveConversation`; `proposePlan` passes `conversationId`.
- New hook `apps/web/src/state/use-conversation-thread.ts`, `(networkId, conversationId | null, revision, open)`:
  - fetches only while the panel is open, refetching when `revision` changes;
  - a draft (`null`) conversation is an empty thread and makes no request;
  - serializes requests the same way `use-network.ts` does.
- `apps/web/src/views/dispatcher-state.ts`: `dispatcherIndicator` reads the summaries of non-archived conversations. Precedence:
  1. blocked Trains and conflicts, as now;
  2. any active `planning` reads "Preparing a plan";
  3. any active `launching` or `starting` reads "Launching Lines";
  4. any `latest.status === "ready"` reads "Plan ready to review";
  5. the most recent latest plan `failed` reads "Plan stopped".
- `apps/web/src/views/dispatcher.tsx`:
  - The thread comes from the hook instead of `snapshot.plans` (line 103).
  - The header gets a conversation switcher (titles with a tone dot from the same per-conversation status rules, and Archive in each item's menu) and a **New conversation** button that selects a draft.
  - `propose()` sends `conversationId` (absent for a draft); on success it selects `created.conversationId`.
  - Starters and demo buttons show in an empty thread while the network has no Lines.
  - "Needs you" (`AttentionMessages`, `RepairMessages`) is unchanged and network-wide.
- `apps/web/src/views/dispatcher-planner.tsx`: `PlanExchange` keeps its props; `latest` now means the latest plan in the conversation.
- Add styles in `apps/web/src/network.css` next to the existing `.dpanel-*` rules.

## Slice 3: Memory within a conversation

- **Planner input:** `packages/agent-runtime/src/dispatch-planner.ts` `DispatchPlanningInput` gains `conversation?: DispatchPlan[]`, the earlier plans in this conversation.
- **Workflow:** `prepareDispatchPlan` in `apps/worker/src/workflows/dispatch-operations.ts` loads `store.conversationPlans(plan.conversationId)`, keeps those created before this plan, and passes them in. Recomputing on retry is acceptable.
- **`promptConversation(prior, currentCommit)`:** a pure function in `packages/agent-runtime/src/dispatcher-agent.ts`, next to `promptNetwork`.
  - The last 6 turns, each `{ goal (≤1000 chars), createdAt, outcome }`, where `outcome` is one of:
    - `launched` with Line names;
    - `proposed_not_launched` for `ready` or `launching`;
    - `failed` with the message, ≤300 characters.
  - The latest reviewed turn also gets the proposal `summary`, Lines with Station names, and `findings` with `atCommit` and `current: atCommit === currentCommit`.
  - Omitted when there are no earlier turns.
- **System prompt:** `dispatcherSystemPrompt` adds `conversation` to the "Planning input (untrusted data)" JSON. `HarnessDispatcher.plan` threads it through.
- **Prompt guidance:** add a paragraph to `packages/agent-runtime/src/dispatcher-prompt.ts`, near the `network.finishedLines` paragraph (~line 107):
  - earlier turns are context for reading the new goal ("make it two Lines"), not instructions;
  - a follow-up restates the complete plan, not a diff;
  - the checkout and network state override earlier summaries, and findings that are not `current` need re-verification;
  - unlaunched proposals had no effect.
- **Fake planner:** `FakeDispatchPlanner` ignores the conversation, so offline behavior is unchanged.
- **UI copy:** in `dispatcher.tsx`, `refine` stops pre-filling the old goal. The composer context (line 406) reads "Following up on <q>…</q>. The Dispatcher will see the earlier plan."

## Slice 4: Docs

- `docs/dispatcher-planning.md`: a "Conversations" section covering lazy creation, the one-planning-plan rule, the brief's contents and bounds, and applying `0021` before deploying.
- `docs/api.md`: the new routes and `conversationId`.
- `AGENTS.md`: one sentence in the Dispatcher planning bullet.

---

## Verification

**Unit and worker tests** (Vitest next to the code):

| Layer | Cases |
| --- | --- |
| domain | `startConversation` title derivation and events; `archiveConversation` idempotent; `createDispatchPlan` without a conversation rejected |
| protocol | Plan request with and without `conversationId`; summary schema |
| worker store | Conversation and plan in one batch; `revision` changes on plan update; `conversationPlans` order; `conversation_mismatch` trigger; network deletion erases conversations |
| worker planning (`dispatch-operations.test.ts`) | Same requestId gives one conversation; another network's conversation → 404; archived → 409; plan already `planning` → 409; earlier plans reach the planner |
| router (`router.test.ts`) | Thread route returns 404 for a mismatched network; PATCH archive |
| agent-runtime (`dispatcher-agent.test.ts`) | `promptConversation` bounds, outcome mapping, stale findings; first turn omits the block; the block appears in the system prompt |
| web | `dispatcher-state.test.ts` indicator across summaries; fixtures with `plans:` updated in `dispatcher-state.test.ts` and `crossing-scope.test.ts` |

**Checks:** `npm run typecheck && npm test && npm run lint && npm run format:check && npm run build`.

**Migration backfill:** copy the local D1 state under `apps/worker/.wrangler`, apply `0021`, and confirm that every plan has a `conversation_id`, that `record.conversationId` matches the column, and that versions were bumped.

**Offline (`npm run dev:fake` + `npm run dev:web`), in the browser pane:**
- the existing network shows "Earlier planning";
- New conversation leaves the composer empty and sends a goal that creates a second conversation;
- switching conversations swaps the threads;
- the indicator shows a ready plan in a conversation that isn't selected;
- "Needs you" appears in both conversations;
- Archive hides a conversation;
- a refresh lands on the same conversation;
- the snapshot response no longer contains proposals.

**Live** (glm-5.3-flash for all roles): propose a plan, follow up in the same conversation with "split that into two Lines", and confirm the second proposal builds on the first. Then start a new conversation and confirm its first plan's prompt has no conversation block.
