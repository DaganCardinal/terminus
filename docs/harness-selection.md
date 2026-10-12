# Per-role harness selection

Settings → Agents configures Dispatcher, Conductor, Station Agent and Technician independently. OpenCode is the default for every role and every preset. Engineer remains a direct Clef decision model. General settings apply unless a network saves a complete override; clearing the override follows General again. Custom settings include `models` and `harnesses`, while older model-only settings normalize to OpenCode without changing models.

| Harness | Pinned CLI | Compatible providers |
| --- | --- | --- |
| OpenCode | 1.18.32 | Workers AI, Anthropic Messages, OpenAI Responses |
| Claude Code | 2.1.280 | Anthropic Messages |
| Codex | 0.156.1 | OpenAI Responses |

The protocol catalog owns native API model IDs, provider identities, compatible harnesses and explicit cost order. New choices are Claude Haiku 4.5, Claude Sonnet 5.5, GPT-6 Luna and GPT-6 Sol; the existing Workers AI choices remain. Harness changes preserve a compatible model, otherwise choose Haiku 4.5 for Claude Code or GPT-6 Luna for Codex. The form shows the replacement before saving and switches to Custom. Backend validation independently rejects incompatible combinations. Runtime failures never switch harness, model or provider.

## Gateway and provider setup

All supported providers route through the configured AI Gateway. Terminus has no provider-key input, key storage, alias selector, billing switch or gateway-management API.

For your own Anthropic/OpenAI account, enable an [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) and store the provider key with the **default** alias in [Cloudflare's Provider Keys dashboard](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/). The Worker uses the existing account-scoped `AI_GATEWAY_TOKEN` secret; it needs AI Gateway Run for provider-native routes and Workers AI Read for the existing Workers AI endpoint. Gateway configuration controls billing. Verify your intended routing in Cloudflare before enabling paid work.

The Sandbox receives only a placeholder key (where required by its harness). The outbound Worker authorizes one exact provider and endpoint, the role's native model, and that model's utility model: the lowest-cost catalog model from the same provider, which harnesses use only for housekeeping such as session titles (OpenCode `small_model`, Claude Code `ANTHROPIC_DEFAULT_HAIKU_MODEL`). It discards Sandbox-supplied credentials and all `cf-aig-*` routing/billing headers before injecting trusted authentication. It passes streams through and refuses redirects and hosted tools that would execute outside the Sandbox's restrictions. No provider credential enters Sandbox configuration, environment or event capture. Provider-native BYOK lookup relies on omitting provider authentication, as Cloudflare documents.

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

OpenCode retains its existing configuration-disabling environment and deny rules; only its read-only `explore` agent may be delegated to. Claude uses bare mode, explicit tool lists, empty configuration sources and MCP configuration, disabled hooks, and strict native Bash sandbox settings. Codex uses isolated `CODEX_HOME`, an untrusted project, disabled project instructions/discovery and an enforced named filesystem profile. Native planning cannot write the checkout. Native review profiles make the candidate read-only and allow temporary output only under `/tmp` and `/workspace/review`. Candidate fingerprint checks remain mandatory for every harness, after initial answers and corrections.

Native enforcement is deliberately strict. A repository whose checks require writes into the sealed candidate may need its build/test output redirected to allowed temporary paths; a harness that cannot enforce its profile in Cloudflare must fail. Do not introduce unsandboxed retries, permission bypass flags or prompt-only substitutes to make a check pass.

Dispatcher and Conductor corrections resume the original native session. Session files remain only in the disposable Sandbox and are not disabled for these roles. Raw event and tool output stays local; only final text, failure, session identity and tool counts are returned. Process exit is the completion trigger, but Claude also requires a successful non-error result, and Codex requires a completed turn with a final agent message. Missing, malformed or truncated final outcomes fail. Independent validation, scoped repair verification and repository grants remain unchanged.

Integration references: [Cloudflare Claude Code](https://developers.cloudflare.com/sandbox/coding-agents/claude-code/), [Cloudflare Codex](https://developers.cloudflare.com/sandbox/coding-agents/codex/), [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Claude continuation](https://code.claude.com/docs/en/headless), [Codex noninteractive execution](https://developers.openai.com/codex/noninteractive/), [Codex configuration](https://developers.openai.com/codex/config-reference/).

## Release verification

`ALTERNATIVE_HARNESSES_ENABLED` defaults to `false`. Real settings expose the release gate and disable alternatives until enabled; the API rejects bypass attempts, and preparation checks again before execution. External-provider models under OpenCode are also gated. Fake mode accepts every combination without starting CLIs or calling a provider.

The automated suite is credential-free. It covers catalog compatibility, legacy settings, all twelve role/harness command and continuation fixtures, outcome failures, event filtering, immutable D1 configuration, checkpoint mismatches, offline execution, exact routing, header replacement, streaming and upstream failure handling.

Before enabling alternatives, the maintainer must:

1. Apply migration 0014 and deploy the pinned image with the gate off. Drain active legacy Trains, Stations, plans, integrations, Junctions and repairs before changing providers.
2. Explicitly authorize new-provider calls; the repository's GLM-only testing instruction continues to apply.
3. In real Cloudflare Sandboxes, verify each pinned CLI starts with its restrictive profile, cannot activate repository instructions/hooks/plugins/skills/MCP, and cannot modify a planning checkout or an accepted review candidate. Confirm exact installed versions.
4. For each harness run planning, implementation, every Conductor review kind (Station, Crossing, Junction input/feature, repair), and Technician repair. Exercise at least one correction in the same native session, streaming, malformed/failing outcomes and infrastructure recovery without replaying a completed checkpoint.
5. Change settings between Stations, revisions, reviews and retries; verify the original snapshots and provenance remain in use. Verify provider credentials never appear in Sandbox files, environment, events or logs.
6. Verify default dashboard BYOK and the intended Cloudflare billing configuration without passing provider credentials through Terminus. Check upstream failures and invalid keys do not cause runtime fallback.
7. Only after those checks pass, set `ALTERNATIVE_HARNESSES_ENABLED=true` in the real deployment. Keep fake mode offline.

These live checks have not been performed by this implementation. Local fixtures cannot prove native Linux enforcement, pinned-binary continuation, streaming transport or dashboard billing behavior inside Cloudflare.
