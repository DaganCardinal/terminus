# Per-role harness selection

Settings → Agents configures Dispatcher, Conductor, Station Agent and Technician independently. OpenCode is the default for every role and every preset. Engineer remains a direct Clef decision model. General settings apply unless a network saves a complete override; clearing the override follows General again. Custom settings include `models` and `harnesses`, while older model-only settings normalize to OpenCode without changing models.

| Harness | Pinned CLI | Compatible providers |
| --- | --- | --- |
| OpenCode | 1.18.32 | Workers AI, Anthropic Messages, OpenAI Responses |
| Claude Code | 2.1.280 | Anthropic Messages |
| Codex | 0.156.1 | OpenAI Responses |

The protocol catalog owns native API model IDs, provider identities, compatible harnesses and explicit cost order. New choices are Claude Haiku 4.5, Claude Sonnet 5.5, GPT-6 Luna and GPT-6 Sol; the existing Workers AI choices remain. Harness changes preserve a compatible model, otherwise choose Haiku 4.5 for Claude Code or GPT-6 Luna for Codex. The form shows the replacement before saving and switches to Custom. Backend validation independently rejects incompatible combinations. Runtime failures never switch harness, model or provider.

## Gateway and provider setup

All supported providers route through the configured AI Gateway. Anthropic and OpenAI calls are paid with [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/): prepaid Cloudflare credits, with provider pricing passed through. Terminus has no provider-key input, key storage, alias selector, billing switch or gateway-management API.

Gateway setup: enable an [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/), load Unified Billing credits, leave **Require provider credentials** off, and keep no Anthropic or OpenAI key under the **default** alias in Provider Keys. Cloudflare resolves a request's credentials in order: a provider key on the request, then a stored `default` BYOK key, then Unified Billing. The Worker never sends a provider key, so a stored `default` key would silently take over billing. Set [spend limits](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) on the gateway to cap paid work. The Worker uses the existing account-scoped `AI_GATEWAY_TOKEN` secret; it needs AI Gateway Run for provider-native routes and Workers AI Read for the existing Workers AI endpoint.

The Sandbox receives only a placeholder key (where required by its harness). The outbound Worker authorizes one exact provider and endpoint, the role's native model, and that model's utility model: the lowest-cost catalog model from the same provider, which harnesses use only for housekeeping such as session titles (OpenCode `small_model`, Claude Code `ANTHROPIC_DEFAULT_HAIKU_MODEL`) and for OpenCode's read-only `explore` subagent. It discards Sandbox-supplied credentials and all `cf-aig-*` routing/billing headers before injecting trusted authentication. It passes streams through and refuses redirects and hosted tools that would execute outside the Sandbox's restrictions. No provider credential enters Sandbox configuration, environment or event capture. Unified Billing relies on omitting provider authentication, as Cloudflare documents.

## Ownership and durability

Role prompts and capability profiles live in `packages/agent-runtime`; boundary validation and curated metadata live in `packages/protocol`; Sandbox, D1 and provider adapters live in the Worker. Every role uses `prepareHarness` and adapters from `harness-adapters.ts`. Shared role definitions declare planning, review, implementation or repair capabilities, rather than OpenCode permission objects.

Migration `0014_execution_configs.sql` adds immutable D1 snapshots keyed by work kind and identity. Creation commits store the snapshot in the same batch as the entity and events. Request handlers that already resolved settings pass that exact configuration to creation, avoiding a settings race while preparing repositories.

- A Train freezes its configuration when created. Every Station run, revision and Train Conductor review resolves it; Crossing reviews use the receiving Train's Conductor.
- A planning request freezes Dispatcher configuration. Correction loops and Workflow retries reuse it.
- A repair dispatch freezes Technician and repair-review configuration, including Junction repairs.
- A Junction launch freezes its Conductor configuration for input and feature acceptance reviews. Its incoming Trains freeze their own configuration in the launch transaction. An outgoing Train freezes its configuration when created at release.

Modern provenance records harness identity, verified pinned version, provider and model. Station and Conductor checkpoints compare the full identity before reuse. Historical model-only provenance is not rewritten. Existing Workflow step names and model fields remain compatible with cached results; a legacy step without execution metadata means OpenCode. Active legacy work must be drained before new provider selections are enabled, because its original full configuration was never persisted.

## Runtime controls

The shared preflight removes user-level harness configuration after repository install scripts, reads capped root `AGENTS.md` or `CLAUDE.md` without following symlinks, and attaches it as randomly delimited repository data. Each adapter writes trusted configuration outside the checkout and verifies `--version` against the pinned image before starting.

OpenCode retains its existing configuration-disabling environment and deny rules; only its read-only `explore` agent may be delegated to. Claude uses explicit per-role tool lists, empty configuration sources and MCP configuration, disabled slash commands and hooks, and denies `.env` reads; it does not use bare mode, which drops Glob and Grep. Codex uses isolated `CODEX_HOME`, an untrusted project, disabled project instructions/discovery, and no bundled skills or skills instructions. On GPT-6 models Codex 0.156.1 always offers its multi-agent tools (`spawn_agent` and related); no configuration removes them. Spawned agents inherit the role's prompt and model grant, and the outbound Worker refuses any other model.

### Security boundary

The Sandbox container and the outbound Worker are the security boundary. A container starts without internet access; every request goes through the Worker, which allows only the repository granted for that step, the granted model and npm registry reads. No credential enters a container, and containers are disposable. Claude Code's Bash sandbox and Codex's command sandbox (bubblewrap, which needs user namespaces that a container may not allow) are therefore off, as in Cloudflare's own guides: Claude runs with `sandbox.enabled: false` in `dontAsk` mode, and Codex runs with `--dangerously-bypass-approvals-and-sandbox`. Planning and review roles still have no edit tools in Claude, but a shell (Codex for every role, Claude for review) can write the checkout; repository access is already dropped for planning, and candidate fingerprint checks discard any review that changed tracked files.

Unsandboxed, Codex loads the repository's `.codex/config.toml` even for an untrusted project. Our `--config` flags take precedence, `developer_instructions` is overridden to empty, and the managed `/etc/codex/requirements.toml` allows no MCP servers. Two repository settings still apply and cannot be overridden in 0.156.1: agent roles defined under `.codex/agents/` are offered to `spawn_agent`, and `shell_environment_policy.set` variables reach Codex's commands.

Dispatcher and Conductor corrections resume the original native session. Session files remain only in the disposable Sandbox and are not disabled for these roles. Raw event and tool output stays local; only final text, failure, session identity and tool counts are returned. Process exit is the completion trigger, but Claude also requires a successful non-error result, and Codex requires a completed turn with a final agent message. Missing, malformed or truncated final outcomes fail. Independent validation, scoped repair verification and repository grants remain unchanged.

Integration references: [Cloudflare Claude Code](https://developers.cloudflare.com/sandbox/coding-agents/claude-code/), [Cloudflare Codex](https://developers.cloudflare.com/sandbox/coding-agents/codex/), [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Claude continuation](https://code.claude.com/docs/en/headless), [Codex noninteractive execution](https://developers.openai.com/codex/noninteractive/), [Codex configuration](https://developers.openai.com/codex/config-reference/).

## Release verification

`ALTERNATIVE_HARNESSES_ENABLED` is `true` in the real deployment and `false` in fake mode, where it is not consulted. When `false`, real settings disable alternatives; the API rejects bypass attempts, and preparation checks again before execution. Fake mode accepts every combination without starting CLIs or calling a provider.

Anthropic and OpenAI models under OpenCode need `OPENCODE_EXTERNAL_PROVIDERS_ENABLED=true` as well, and it is `false` in the real deployment. Their configuration is covered by unit tests (`opencode.test.ts` checks that each provider block resolves to the exact gateway route the outbound handler grants, with native model IDs), but no OpenCode run has called those providers live. Unverified: whether OpenCode 1.18.32 bundles `@ai-sdk/anthropic` and `@ai-sdk/openai` or fetches them from npm, whether its OpenAI handling (Responses API, `store`, encrypted reasoning) applies to the custom `terminus` provider, and how well these models work without extended thinking and with the 131k context limit. Until then, Claude Code and Codex serve those providers, and Settings falls back to a Workers AI model when a role is switched to OpenCode. Turn the gate on only after step 4 of the checklist below passes for OpenCode with Claude Haiku 4.5 and GPT-6 Luna.

The automated suite is credential-free. It covers catalog compatibility, legacy settings, all twelve role/harness command and continuation fixtures, outcome failures, event filtering, immutable D1 configuration, checkpoint mismatches, offline execution, exact routing, header replacement, streaming and upstream failure handling.

Live verification checklist (still outstanding):

1. Apply migration 0014 and deploy the pinned image with the gate off. Drain active legacy Trains, Stations, plans, integrations, Junctions and repairs before changing providers.
2. Explicitly authorize new-provider calls; the repository's GLM-only testing instruction continues to apply.
3. In real Cloudflare Sandboxes, verify each pinned CLI starts, runs commands, cannot activate repository instructions/hooks/plugins/skills/MCP beyond the Codex exceptions above, and cannot reach anything but the granted repository, model and npm registry. Confirm exact installed versions.
4. For each harness run planning, implementation, every Conductor review kind (Station, Crossing, Junction input/feature, repair), and Technician repair. Exercise at least one correction in the same native session, streaming, malformed/failing outcomes and infrastructure recovery without replaying a completed checkpoint.
5. Change settings between Stations, revisions, reviews and retries; verify the original snapshots and provenance remain in use. Verify provider credentials never appear in Sandbox files, environment, events or logs.
6. Verify calls are charged to Unified Billing credits (no `default` provider key stored) without passing provider credentials through Terminus. Check upstream failures and exhausted credits do not cause runtime fallback.
7. Keep fake mode offline.

The maintainer enabled `ALTERNATIVE_HARNESSES_ENABLED=true` in the real deployment before these live checks were performed. Local fixtures cannot prove native Linux enforcement, pinned-binary continuation, streaming transport or dashboard billing behavior inside Cloudflare.
