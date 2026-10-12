# Dispatcher reasoning and activity: research and recommendations

Research date: October 12, 2026. This is a design recommendation, not an implementation change.

The Dispatcher already has a useful execution activity foundation in the current working tree. To match established assistant interfaces, the next investment should be **structured tool lifecycles, meaningful progress updates, and progressive disclosure**. Showing every reasoning token would not substitute for those capabilities.

## Research scope

I inspected primary source code and rendering tests from OpenCode, Cline, LibreChat, and Open WebUI. These are established, publicly inspectable projects; their inclusion is not a security endorsement. This was source research, not a comparative usability study or a live test of their interfaces. Some inspected code is on development branches, so the findings describe those snapshots rather than every released version.

Sources are pinned to the commits inspected:

| Project | Snapshot | Why it is useful here |
| --- | --- | --- |
| OpenCode | `1438073271baec1ba15032b70824aab77afd5128` | Coding-agent timeline, reasoning modes, grouped tools and subagent cards. |
| Cline | `55d32c22ab50a928865dfaa4f9356600a966a7bc` | Coding-agent tool cards, approvals, reasoning disclosures and loading behavior. |
| LibreChat | `e1dfc10449ff713faffacd60273fddcfe2c0a698` | General assistant with explicit commentary, reasoning, tool grouping and generated activity labels. |
| Open WebUI | `f8ae8a6c328946dc62cd0712961a0632574581bf` | General assistant with structured output, collapsed details and visible interactive gates. |

I separately inspected OpenCode **v1.18.32**, the version Terminus pins, for transport limitations. Its CLI behavior matters more to implementation feasibility than newer OpenCode UI behavior.

## What the projects show, and when

### OpenCode

The inspected UI supports hidden, compact and full reasoning modes. Compact mode exposes a heading while reasoning is active, with the body behind a disclosure. After reasoning finishes, its header becomes a completed thought with a duration. The active Thinking row disappears when a tool or assistant text follows. Tests explicitly ensure the UI does not infer a reasoning block merely from provider identity: a reasoning payload must actually exist. [Reasoning projection tests][oc-reasoning]

Tool groups summarize counts and categories while retaining ordered details. Subagents appear in the summary as agents and retain individual card titles. Tests check that a user's disclosure choice survives new entries arriving. Shell commands and results are inspectable inside their cards. [Tool group tests][oc-tools]

**Lesson for Terminus:** separate activity types, use stable identities, and preserve the reader's expansion choices. Reasoning visibility is a configurable presentation policy, not a synonym for whether the agent is working.

### Cline

Reasoning has a dedicated Thinking component, with separate visibility, expansion and streaming inputs, a bounded scrolling body, and an active shimmer. Tool rendering is specific to the operation: file reads expose a path and optionally line ranges; searches and other operations have their own cards. [Thinking component][cline-thinking], [tool rows][cline-rows]

Its waiting indicator uses backend turn state when available. It avoids showing Thinking during approval, follow-up, completion or error states, and suppresses a duplicate loader while content is visibly streaming. A 500 ms grace period handles an ambiguous streaming-to-complete transition so the loader does not flash at the end of each turn. This loader is an execution indicator, distinct from the actual reasoning body. [Waiting indicator implementation][cline-waiting]

**Lesson for Terminus:** distinguish waiting for model output, running tools, waiting for the user, and being finished. Visibility and animation should follow reported state.

### LibreChat

The grouping code distinguishes assistant commentary from reasoning and tool calls. Without a meaningful activity label, commentary splits groups and remains independently visible; a generic collapsed group must not swallow it. Interleaved reasoning can join tool groups, and pure reasoning retains its own card. [Grouping implementation][lc-grouping]

Completed groups collapse according to preferences and conditions. The implementation also respects explicit user expansion choices. Individual tool details can show output with parameters behind another disclosure. [Group component][lc-group], [disclosure state][lc-disclosure], [tool details][lc-details]

One particularly relevant feature is generated activity labels: after a batch of tools finishes, a detached model call can produce a short outcome-oriented header. Its instruction asks for what the calls established, rather than repeating their names or counts. Failure to generate a label leaves the slot empty and does not hold up the agent. This is an optional model-generated summary layer over execution records, not intrinsic reasoning or proof of correctness. [Activity label runtime][lc-labels]

**Lesson for Terminus:** “Found a shared dependency between the proposed Lines” explains more than “Searched the project.” A summary should complement the underlying tool records and remain attributable to the model.

### Open WebUI

Its structured renderer separates normal assistant messages from detail items and consecutive detail groups. Detail expansion defaults to the user's preference, falling back to collapsed. Tool cards expose arguments and results on expansion. [Structured renderer][ow-renderer], [tool display][ow-tool]

Consecutive details summarize tool names/counts and use active versus past-tense labels. Failure and rejection indicators are represented separately from success. Approval controls can remain visible even when the group is collapsed. Reasoning details use Thinking while active and Thought, optionally with duration, when complete. [Detail groups][ow-groups], [reasoning disclosure][ow-collapsible]

**Lesson for Terminus:** routine details can fold away, while a decision or failure still needs to be visible at the summary level.

## Who decides what appears?

The following is a synthesis of the inspected implementations, rather than one universal algorithm:

1. **The model/provider supplies available content:** assistant prose, exposed reasoning text or summaries, and proposed tool calls. Not every model exposes reasoning text.
2. **The runtime supplies execution facts:** tool identity, lifecycle, result, errors, and turn/run state.
3. **The backend normalizes and retains those records.** Transport and storage determine what can survive a reconnect or be inspected later.
4. **The UI applies presentation rules:** group adjacent operations, show concise headers, mark active work, collapse completed details, and keep questions or failures discoverable.
5. **User preferences and explicit disclosure choices override presentation defaults.**

A model can choose to write commentary, and a separate model can generate group labels. Neither should decide whether a tool succeeded or whether Terminus permits launch. Those are runtime and domain facts.

“Reasoning” therefore needs three distinct meanings in the Dispatcher:

| Content | Owner/source | Recommended treatment |
| --- | --- | --- |
| Execution activity: read, search, exploration, proposal check | Harness or orchestration observation | Compact live header; expandable details. |
| Public progress and rationale: findings, assumptions, why Lines are separated | Dispatcher model | Short visible updates; structured rationale on the final proposal. |
| Provider-exposed reasoning text or summary | Provider/harness, where supported | Optional disclosure with accurate labeling; not required for basic parity. |

An opaque reasoning token count or signature is not displayable thought text. A tool completion is evidence of execution, not evidence that the model's conclusion is true.

## What Terminus already has

This assessment includes existing uncommitted work; it does not establish what is deployed.

- `packages/protocol/src/agent-activity.ts` defines phases and five tool categories, reported status, and an optional safe repository-relative path.
- `packages/agent-runtime/src/harness-activity.ts` filters native events inside the Sandbox. It deliberately excludes text, reasoning, commands, search expressions and tool results.
- `apps/worker/src/integrations/dispatch-activity.ts` batches observations into D1, guards writes by attempt identity, and retains up to 200 observations including the latest phase. Beginning a new attempt replaces previous activity.
- `apps/web/src/state/use-dispatch-activity.ts` polls while visible at 1.5-second intervals, paginates catch-up, handles retries, and fetches terminal activity.
- `apps/web/src/views/dispatch-activity.tsx` shows the last three observations during planning, plus expandable history. Completed activity is behind a disclosure.
- `apps/web/src/views/dispatcher-planner.tsx` shows the phase, real elapsed time, the exact baseline commit, final proposal, exploration findings, trusted baseline check results, and launch blockers.
- `packages/protocol/src/dispatch.ts` already has proposal summaries and findings with cited paths. `dispatcher-prompt.ts` asks for rationale in those fields and currently prepares one proposal rather than an ongoing conversational session.

This already covers basic progress visibility, persistence and progressive disclosure. The remaining work is about better information and stronger lifecycle semantics.

## Concrete gaps

| Gap | Current behavior | What parity requires |
| --- | --- | --- |
| Tool identity | Sequence identifies an observation, not a tool invocation. | Invocation ID so start/end/error update one operation. |
| Live activity | The filter can accept running states, but the default CLI does not emit tool starts. | A transport that supplies starts, or honest completed-only presentation. |
| Parallel exploration | Generic exploration observations, without task titles or parent/child relationships. | Named tasks, parent identity, and independent task status. |
| Useful progress prose | Assistant text and reasoning are discarded. | A bounded, explicit public-update channel, separate from proposal JSON. |
| Inspectable detail | Tool category and sometimes path only. | Allowlisted metadata such as read ranges, selected paths, safe failure categories and result counts. |
| Consistent adapters | Claude activity currently reports tool starts without mapping results; Codex maps command items only. | Per-adapter lifecycle mapping and explicit disclosure of unsupported visibility. |
| History completeness | Up to 200 recent observations; old attempts are replaced. | Explicit truncation metadata and durable run summaries; retained old attempts if full historical inspection becomes a requirement. |
| Visibility of problems | Tool failures can disappear from the three-row preview or into completed history. | A visible group-level failure summary, distinct from a terminal planning failure. |

The transport limitation is verified in [OpenCode v1.18.32's CLI][oc-pinned-run]: `tool_use` JSON is emitted for completed/error tool states, text is emitted after the text part ends, and enabled reasoning is emitted after its part ends. This is live delivery of completed parts, **not token streaming or live tool-start delivery**. Enabling `--thinking` alone does not fix it. The current Terminus command enables that flag for benchmark instrumentation, but the public activity filter still discards reasoning.

## Recommended Dispatcher experience

During preparation, show the actual preparation phase and elapsed time. During exploration, show one compact current-activity header with counts based on observed invocation identities. Completed operations can be grouped under it, with details available on demand. Where start events are unavailable, say “Read 8 files,” rather than claiming “Reading a file.”

Show short public updates at meaningful boundaries: a finding that changes the plan, a dependency that affects concurrency, or a proposal correction. Avoid publishing a message for every read or inventing fresh progress because a timer elapsed. For long quiet periods, show elapsed time and time since the last observation, without asserting that the process is stuck.

Named exploration tasks should have individual cards when actual task events are available. Do not manufacture a child timeline from the parent's final report.

After completion, keep the proposal and its rationale prominent. Fold routine execution into a summary such as “Explored 14 files; completed 2 focused investigations,” with accurate failure/truncation indicators. Distinguish a proposal accepted by schema/assessment checks from a plan launched by the user and from work accepted by the Conductor.

Failures and required user decisions should remain visible outside collapsed details. A failed search that the agent recovered from should be marked as a recovered tool failure, not presented as a failed plan.

## Implementation mapping

### Protocol and shared harness

Extend `agent-activity.ts` with invocation identity, parent identity where available, source, timing and terminal statuses, plus explicit public-update records. Keep record types separate from domain events. Add bounded typed detail fields by tool category instead of an arbitrary `input` or `output` object. Preserve compatibility with historical observations that have no invocation IDs.

Implement native event normalization in `harness-activity.ts` and the shared harness adapters. Review `harness.ts` and `dispatch-session.ts` for delivery and terminal reconciliation. Do not add a Dispatcher-specific harness-start bypass.

For genuine OpenCode in-flight visibility, investigate its native event subscription inside the existing Sandbox, rather than expecting the JSON CLI to supply missing events. Keep `prepareHarness`, repository-content policy, frozen configuration and outbound grants intact. This needs a targeted compatibility/security check and live verification. A simpler completed-only feed can ship first.

### Public progress and rationale

Add an explicit, schema-validated public progress tool or equivalent typed channel. Its payload could contain a short summary, selected repository paths, and references to observed activity IDs. Give it a narrow observational capability: it cannot launch, change topology, or modify Train state.

Update the Dispatcher prompt to request concise progress at meaningful boundaries. Preserve the proposal-only final output and the accepted-submission early exit. Do not render every native text event: it can contain final proposal JSON, correction content or repository excerpts.

Start with updates produced by the existing planning session; a second model generating batch labels introduces extra cost and routing complexity. If added later, follow LibreChat's nonblocking, failure-tolerant pattern and freeze its configuration through the existing role configuration system. A validated update shape does not validate the truth of its contents.

### Worker persistence and UI

Extend the existing D1 activity store and API rather than adding another infrastructure primitive. Preserve attempt guards, bounded buffering, visibility-aware polling and planning independence from telemetry writes. Add truncation/dropped-observation metadata and durable aggregate summaries; the latest 200 records cannot establish totals for the whole run.

In `dispatch-activity.tsx`, project invocation records into stable grouped cards, counts, durations and task rows. Keep expansion choices across regrouping. In `dispatcher-planner.tsx`, present public updates as separate content and retain the final proposal as the main result. Keep terminal state authoritative so unfinished tool observations become interrupted/unknown when the session ends, rather than falsely becoming successful.

The browser may choose layout, grouping and expansion. It must never infer launch, acceptance, completion or permission to move a Train from activity.

## Priority before the October 14 submission

1. **Make the existing feed more legible:** compact grouped activity, accurate completed-only wording for the default adapter, explicit failure summaries, and truncation indicators. Reuse the current proposal summary/findings for the final rationale.
2. **Add useful progress:** a bounded public-update channel with planning guidance. Then add invocation identity and the transport needed for real tool starts and named exploration tasks. Visibility of child tools should follow only if the adapter actually supplies them.
3. **Defer optional deep inspection:** provider reasoning disclosures, full tool result viewers, and retained historical attempt transcripts. These are valuable for developer inspection but are not prerequisites for a convincing Dispatcher.

The recommended target is a readable collaborator: what it is doing, what it learned, why its plan is shaped that way, and what decision the user needs to make. Raw reasoning is optional.

Full conversational parity is a separate scope. The current Dispatcher prompt explicitly limits a session to one proposal, and the proposal schema has no supported clarification or deferred-plan response. Allowing the user to answer a planning question or steer an active plan would require typed conversation/clarification records, an explicit resume or cancel/replan contract, and rules for which goal and baseline the resulting proposal belongs to. Progress messages alone do not provide those semantics. Keep launch behind the existing explicit command.

## Verification required for implementation

Use captured events from the pinned harness versions to test invocation correlation, duplicate deliveries, parallel completion, tool failures and interruptions. Verify a refresh restores the same activity and a late previous-attempt write cannot contaminate the new attempt.

Verify the UI retains user expansion choices, keeps failure/decision summaries visible, stops working indicators on terminal state, handles unavailable telemetry, and reports truncation honestly. Verify public progress excludes final JSON and unsafe content, and a noisy or failing telemetry path cannot alter orchestration.

Live verification remains separate from this research. Follow the existing maintainer-approved model and harness release constraints; research did not execute models, deploy changes or verify deployed behavior.

[oc-reasoning]: https://github.com/anomalyco/opencode/blob/1438073271baec1ba15032b70824aab77afd5128/packages/session-ui/component-tests/session-timeline-reasoning.spec.ts
[oc-tools]: https://github.com/anomalyco/opencode/blob/1438073271baec1ba15032b70824aab77afd5128/packages/session-ui/component-tests/tool-group.spec.ts
[oc-pinned-run]: https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/cli/cmd/run.ts#L720-L767
[cline-thinking]: https://github.com/cline/cline/blob/55d32c22ab50a928865dfaa4f9356600a966a7bc/apps/vscode/webview-ui/src/components/chat/ThinkingRow.tsx
[cline-rows]: https://github.com/cline/cline/blob/55d32c22ab50a928865dfaa4f9356600a966a7bc/apps/vscode/webview-ui/src/components/chat/ChatRow.tsx
[cline-waiting]: https://github.com/cline/cline/blob/55d32c22ab50a928865dfaa4f9356600a966a7bc/apps/vscode/webview-ui/src/components/chat/chat-view/hooks/useThinkingLoaderRow.ts
[lc-grouping]: https://github.com/LibreChat-AI/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/client/src/utils/groupToolCalls.ts
[lc-group]: https://github.com/LibreChat-AI/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/client/src/components/Chat/Messages/Content/ToolCallGroup.tsx
[lc-disclosure]: https://github.com/LibreChat-AI/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/client/src/components/Chat/Messages/Content/disclosure.ts
[lc-details]: https://github.com/LibreChat-AI/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/client/src/components/Chat/Messages/Content/ToolCallInfo.tsx
[lc-labels]: https://github.com/LibreChat-AI/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/packages/api/src/agents/activityLabels/runtime.ts
[ow-renderer]: https://github.com/open-webui/open-webui/blob/f8ae8a6c328946dc62cd0712961a0632574581bf/src/lib/components/chat/Messages/StructuredOutputRenderer.svelte
[ow-tool]: https://github.com/open-webui/open-webui/blob/f8ae8a6c328946dc62cd0712961a0632574581bf/src/lib/components/common/ToolCallDisplay.svelte
[ow-groups]: https://github.com/open-webui/open-webui/blob/f8ae8a6c328946dc62cd0712961a0632574581bf/src/lib/components/chat/Messages/Markdown/ConsecutiveDetailsGroup.svelte
[ow-collapsible]: https://github.com/open-webui/open-webui/blob/f8ae8a6c328946dc62cd0712961a0632574581bf/src/lib/components/common/Collapsible.svelte
