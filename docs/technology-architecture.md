# Technology Architecture and Ownership

Terminus coordinates concurrent coding agents through a railway domain model. The backend owns lifecycle decisions; the map projects persisted state. Orchestration continues with no browser connected.

> **Artifacts owns code and Git history. Domain + D1 own railway state. Workflows own durable execution. Sandboxes execute code. React owns presentation.**

[AGENTS.md](../AGENTS.md) contains the governing rules. [Structure and ownership](structure-and-ownership.md) maps responsibilities to source packages; [the outline](outline-updated.md) explains the domain concepts. The implemented definitions in `packages/domain` are authoritative for states and transitions.

## Technology stack

| Concern | Technology | Responsibility |
| --- | --- | --- |
| Language and workspace | TypeScript, Node 24, npm workspaces | Shared types and source-only packages compiled by Vite and Wrangler |
| UI | React, Vite, shadcn/ui | Forms, inspection, approvals and command submission |
| Map | React/SVG | Two-dimensional Lines, Stations, Trains, signals and convergence |
| HTTP boundary | Cloudflare Workers | Authentication, request validation, commands and infrastructure adapters |
| Domain | Pure TypeScript | Entities, legal transitions, invariants and Engineer hard gates |
| Durable execution | Cloudflare Workflows | Steps, retries, waiting and recovery |
| Metadata | Cloudflare D1 | Topology, lifecycle state, manifests, provenance, settings and events |
| Code and history | Cloudflare Artifacts | Canonical, Train, Station, integration, Junction, repair and publish repositories |
| Execution | Cloudflare Sandboxes/Containers | Disposable checkouts, harnesses, builds, tests, Git merges and previews |
| Models | Workers AI and AI Gateway | Configured text harness models and direct Clef decisions |
| Dependency cache | R2 | Disposable npm download caches keyed by lockfile |
| Temporary performance logs | Tail Worker and R2 | Benchmark records; separate from the domain event log |
| Browser transport proof | Browser Run and Playwright Core | Gated hosted Chromium proof; agent browser tools and project browser checks remain unimplemented |

The existing R2 cache, benchmark instrumentation and Browser Run proof have bounded purposes. Additional infrastructure still requires approval; do not add a second authoritative state store. Sandbox Durable Objects adapt container execution rather than owning railway lifecycle rules.

## Backend and UI boundary

The Worker serves the built React assets and `/api/*`. Live requests pass Cloudflare Access and in-Worker JWT verification, including issuer, audience, expiry and an allowed email. Mutating browser commands also enforce origin checks. See [deployment](../README.md#deployment) for configuration.

API handlers validate protocol schemas and submit application commands. Commands can persist topology, holds, unloading permissions and repair/release requests, but only the owning Workflow changes a Train's lifecycle state. The UI never requests raw repository creation or merges.

The browser first loads a `NetworkSnapshot`, then polls `/api/networks/:id/events?after=<seq>` while visible. New events trigger a fresh snapshot; the browser does not apply domain transitions itself. The same persisted domain events supply the activity feed and audit history. Every domain change and its event are written in one D1 batch.

Harness activity is separate observational telemetry. It is bounded and filtered, cannot move a Train or authorize launch, and its write failures do not fail planning. The public activity feed excludes raw reasoning, file contents and tool transcripts. See [Dispatcher planning](dispatcher-planning.md).

## Repositories and provenance

Each Project has exactly one Network and one Artifacts namespace, `terminus-<network id>`. Every repository for that Network stays in its namespace; stored repository IDs are `<namespace>/<name>`. Terminus uses the Artifacts REST adapter because the Workers binding is fixed to one namespace at deployment.

Onboarding imports a public HTTPS Git URL through that adapter, or creates an initialized empty canonical repository. A source URL already imported by another Network is refused. Private imports and GitHub synchronization are outside the current scope. Terminus's own source repository is independent of the projects it manages.

| Repository | Meaning |
| --- | --- |
| Terminus | Canonical project state, changed only by successful final integration |
| Train | Its accumulated accepted work; ordinary and incoming Trains fork exact Terminus baselines |
| Station | One isolated run or revision, forked at departure from the Train's current state |
| Integration candidate | An exact merge of frozen source and target snapshots for validation and review |
| Junction | Feature convergence at a frozen Terminus baseline, separate from canonical state |
| Technician | Isolated repair candidate with bounded scope and recorded source snapshots |
| Publish | Explicitly published canonical snapshots watched by Workers Builds |

Outgoing Junction Trains fork the human-approved feature head and retain the frozen Terminus baseline for later canonical integration. A first Station can fork Terminus at the Train's exact baseline when Artifacts refuses to fork a newly created Train repository; the adapter verifies the snapshot and falls back safely. See [Station execution](station-execution.md).

A **Car is a D1 record, not a commit or a separate repository**. It retains the manifest, source and accepted commits, actual changes, independent evidence, review and execution identity. Crossings and Junctions copy missing original Cars with provenance instead of rerunning source Stations.

### Git operations

Station acceptance always fast-forwards the exact reviewed candidate onto the Train. Orchestration owns the push; a Station Agent cannot write a Train or Terminus. Changed target heads and incompatible ancestry block promotion rather than permitting force pushes.

Fast-forward transfers use `packages/artifacts` with isomorphic-git and the Worker's scoped HTTP transport and disposable `/tmp` filesystem. Transfers exceeding 16 MiB or clones exceeding 20,000 objects use the guarded native-Git Sandbox. Capacity limits permit fallback; moved targets and other failures do not. Read-only repository heads use smart-HTTP ref advertisements without starting a Sandbox. Repository browsing reads immutable Artifacts trees and blobs directly and caches overviews by exact commit in D1.

Terminus, Crossing and Junction integrations prepare **merge commits**, preserving every Car's accepted commit. Never rebase, squash or hide unresolved conflicts. Merge preparation and executable validation run in Sandboxes. Promotion is a guarded fast-forward of the exact validated merge commit.

Reservations serialize integration per target repository. Unknown push outcomes retain the reservation until the actual Git head is reconciled. A Junction promotion additionally retains exclusion until its head, accepted-input ledger, receipt, provenance and events are durably acknowledged. See [Terminus integration](terminus-integration.md), [Crossings](crossings.md) and [Junctions](junctions.md).

## Durable Workflow ownership

| Workflow | Identity | Responsibility |
| --- | --- | --- |
| Train | One per Train | Only writer of Train lifecycle state; Engineer gates, departure, Station results, review, Car acceptance and destination unloading |
| Station | One per run | Workspace preparation, frozen harness execution, candidate capture and publication; reports the result to its Train |
| Integration | One per attempt | Shared Terminus, Crossing and Junction merge/validation/review/promotion process over exact snapshots |
| Junction | One per Junction | Only writer of feature lifecycle; serial input scheduling, complete acceptance and explicit release |
| Dispatch | One per planning request | Read-only proposal preparation, persisted draft/recovery, explicit launch and atomic topology creation |
| Technician | One per repair | Isolated bounded implementation, independent validation, Conductor review and exact-candidate approval |
| Conflict Watch | One per eligible accepted Car | Dispatcher triage and read-only trial merges; writes advisory watch records, never Train state |

Workflow transport wakes are distinct from domain event names. Durable checkpoints and periodic gate checks recover interrupted steps and lost notifications. Historical cached step shapes and model-only provenance remain readable; retries do not silently replace frozen execution configurations.

A hold represents an expected wait and clears through its owning gate. A blocker requires intervention. User commands, Station outcomes and other actors notify the owning Train Workflow rather than writing its state directly.

## Station work and independent review

1. The Train's Engineer clears departure and signals the next Station. Its workspace is forked from the current accepted snapshot at that time.
2. The Station Workflow installs dependencies and invokes the frozen implementation harness in its isolated Sandbox.
3. Process exit plus the adapter's successful final outcome detects completion. Orchestration captures actual changes and the candidate commit, checkpoints the result and confirms publication before reporting `ready_for_pickup`.
4. The Train approaches and docks, then its review step prepares a fresh Conductor checkout at the exact candidate. Trusted preparation installs dependencies with no model access, seals tracked files, removes secret files and Git history, and drops repository access.
5. Orchestration runs the configured required checks there before starting the model. This is independent Station evidence; the Station Agent's summary and its own test claims are not evidence of record. Failed checks or a missing diff return work without a model session.
6. The Conductor reads the candidate and review inputs, exercises additional behavior as needed, and returns a schema-validated verdict. A changed tracked-file fingerprint discards the review.
7. The verdict is durable before the Train applies it. Acceptance fast-forwards the candidate and records its Car before signaling the next Station; a return revises the Station, while an escalation blocks for intervention.

Crossing compatibility, Junction input/feature acceptance and Technician reconciliation use the same sealed Conductor path with their own candidate and guidance. Station, integration and repair review steps allow 30 minutes and one retry; complete Junction feature validation/review allows 45 minutes. Trusted preparation failures retry before paid model execution. With fake repositories, reviews use the supplied illustrative diff; with a fake Conductor, Station validation runs in the Station Sandbox. See [Station execution](station-execution.md) and [Harness selection](harness-selection.md) for exceptions and recovery.

One initial Station attempt plus at most three automatic revisions is the default. Required-check returns, Conductor returns and Engineer retries share that allowance. Explicit intervention grants a fresh allowance while retaining lifetime history, feedback and rejected candidates. Infrastructure retries are separate.

## Harnesses and model configuration

Dispatcher, Station Agent, Conductor and Technician use the shared `prepareHarness` path with a role capability profile from `packages/agent-runtime`. The curated catalog in `packages/protocol/src/models.ts` defines compatible providers, native IDs, pinned harness versions and cost ordering.

| Harness | Providers |
| --- | --- |
| OpenCode, the default | Workers AI, Anthropic Messages, OpenAI Responses |
| Claude Code | Anthropic Messages |
| Codex | OpenAI Responses |

Settings → Agents stores General choices in D1, with optional complete per-Network overrides. Presets use OpenCode; Custom selects harnesses and compatible models per role. There are no arbitrary model IDs or runtime provider/model fallbacks.

The default **Extra-light** preset uses GLM-5.3 Flash for Dispatcher, Station Agent, Conductor and Technician, and Clef Flash for Engineer decisions. Light uses GLM-5.3 for the Dispatcher; Medium uses GLM-5.3 for Dispatcher, Conductor and Technician, Kimi K2.7 Code for Station work, and Clef for decisions. The catalog is authoritative; implementation/testing authorization remains governed by [AGENTS.md](../AGENTS.md).

Each harness role also has a reasoning level from the levels its catalog model accepts, Medium by default; see [Reasoning levels](harness-selection.md#reasoning-levels).

`execution_configs` freezes model, provider, harness, version and reasoning level atomically when Trains, plans, repairs and Junctions are created. Revisions, corrections and recovery reuse the snapshot. Settings changes affect new work. Role Worker vars set to `fake` bypass model execution; they do not select production model IDs.

`ALTERNATIVE_HARNESSES_ENABLED` gates native alternatives and external models. OpenCode's external providers additionally require `OPENCODE_EXTERNAL_PROVIDERS_ENABLED`; configuration support is distinct from live verification. See [Harness selection](harness-selection.md#release-verification) for the remaining release checks.

### Dispatcher planning

The Dispatcher explores the exact canonical commit in a read-only Sandbox, optionally after trusted baseline checks. OpenCode can delegate to read-only `explore`; it cannot edit or run shell commands. Its outline and Station tools save draft pieces in D1, and code assembles and validates the proposal. Other harnesses return proposal JSON. Schema and assessment errors receive at most two corrections in the same native session.

Preparation checkpoints bind drafts to the exact repository, commit, checks and execution configuration. Matching retries reuse trusted baseline evidence and valid saved pieces; a complete valid draft can finish without a Sandbox. Launch remains an explicit user command against a current baseline. Stable repository identities and one atomic D1 batch prevent partially laid topology. See [Dispatcher planning](dispatcher-planning.md).

### Engineer decisions and Dispatcher advisories

The Engineer uses deterministic domain gates first. Ambiguous failed-run retries and early revision escalation call a typed **DecisionModel**, implemented by `GatewayDecisionModel` through Workers AI `/ai/run`; they never use a text `ModelProvider` or a harness. Fixed answer options return probabilities. Below the confidence threshold or on failure, deterministic defaults stand: failed runs block and returned work is revised within the allowance.

Decision context includes bounded operational history and independent checks, never diffs or agent summaries. Assessments checkpoint their frozen model, question, input, answer and applied action before consequences. Notification decisions may report recovery situations or prolonged dependency waits but cannot release holds or alter gates. Persistent notices can be acknowledged and resolve when conditions change. Routine movement is recorded without notifying Dispatch.

[Conflict Watch](conflict-watch.md) separately screens accepted Cars against other running Trains, consults the Dispatcher's Clef on gray-zone pairs, and investigates flagged pairs with read-only trial merges and the Dispatcher harness. Reports are advisory; canonical integration still checks actual candidates.

## Sandbox isolation and capacity

Agent Sandboxes use the execution image for all harness roles. Agentless Workspace Sandboxes use a separate image for Git operations, validation and previews and refuse model access. Routing Sandbox objects select container classes for standard-1, standard-2 or standard-3; a running container keeps its size until it stops.

Settings → Sandboxes controls each Network's limits and instance sizes. Defaults are ten agent and ten agentless containers, both standard-2; each kind permits limits from 1 to 100. D1 leases enforce starts across all size classes. Workflow work waits for capacity, previews report unavailable capacity, and lowering limits does not terminate running work. Registered ownership supports explicit Network deletion and container cleanup.

All orchestration installs can restore npm download caches from R2 by lockfile hash. Trusted cache population uses a scratch checkout of only package metadata with scripts disabled; npm verifies tarballs against lockfile integrity. Cache loss causes a fresh install, never loss of accepted work. See [Live setup](live-setup.md#sandboxes-and-limits) and [Station execution](station-execution.md#constraints).

### Security boundary

The container and the outbound Worker enforce isolation; the harness's own command sandbox is not the boundary. Containers have no unrestricted internet access. The Worker grants only required repository operations, exact model endpoints and npm registry reads, and removes caller-supplied authentication before injecting trusted credentials.

Account-level repository and model credentials stay in the Worker. Conductor sessions never have repository write grants; Station Agents never receive authority over Trains or Terminus. Model grants include the configured role model and its same-provider utility model for housekeeping and permitted exploration. Anthropic/OpenAI calls use AI Gateway Unified Billing without provider keys in Terminus.

Shared preparation disables harness discovery, hooks, skills and repository instruction loading as supported by each pinned adapter. Preflight removes user-level configuration after install scripts and attaches capped root guidance as randomly delimited repository data. Known native-adapter limitations are documented in [Harness selection](harness-selection.md#runtime-controls); enforcement stays outside the agent. Independent validation, exact-commit checks and Conductor fingerprints remain mandatory.

## Human permissions, previews and publishing

Unloading policy is Dispatcher-owned D1 metadata, separate from Train state. Human approval binds to an exact accepted Train commit and gates only final Terminus entry. The Train Workflow records the review-yard hold; waiting approval reserves no integration clearance. Approval never bypasses checks, conflicts or other holds. See [Unloading](unloading.md).

Junction input acceptance is automatic validation and compatibility review. Complete feature acceptance precedes a separate commit-bound human release, which creates exactly one outgoing Train. Technician repair approval authorizes only the reviewed repair candidate, not feature release or publishing. See [Junctions](junctions.md) and [Technician repairs](technician.md).

[Previews](previews.md) check out exact accepted Train or Terminus commits in read-only agentless Sandboxes, build and serve them on separate origins, and do not affect lifecycle or canonical state. Browser Run currently supplies only the gated [transport proof](browser-run.md), not agent browser tools or independent project browser checks.

[Publishing](publishing.md) explicitly forks Terminus into a `publish` repository at the displayed canonical commit and subsequently fast-forwards it. Workers Builds is connected once in the dashboard and deploys that repository. Canonical integration never publishes automatically, and Terminus holds no managed-project deployment credentials.

## Sources of truth

| State | Owner |
| --- | --- |
| Code, trees, commits and accepted history | Artifacts |
| Railway entities, topology, manifests, Cars and lifecycle records | Domain + D1 |
| Settings, frozen execution configuration and human permissions | D1 |
| Domain event history | D1, atomic with each change |
| Train lifecycle writes | Its Train Workflow |
| Junction lifecycle writes | Its Junction Workflow |
| Process checkpoints, retries and waiting | Workflows |
| Disposable command and harness execution | Sandboxes |
| Role prompts, capabilities and model adapters | Agent runtime |
| Selection, layout, zoom and animation | React |

A manifest copied into a checkout is context, not authoritative state. Disposable caches and telemetry cannot replace Artifacts, D1 or Workflow checkpoints. Losing a Sandbox must lose no accepted work.
