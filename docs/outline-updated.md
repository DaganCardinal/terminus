# Terminus

## Overview

Terminus is an agent-oriented software development orchestration platform built around a railway network metaphor.

The system is designed to coordinate multiple coding agents working concurrently or sequentially across a shared codebase while maintaining clear ownership, review boundaries, dependency handling, conflict forecasting, integration safety, and human oversight.

Rather than presenting agent activity as a collection of branches, pull requests, worktrees, or isolated chat sessions, Terminus represents development as a living rail network.

Tasks become **Stations**, workstreams become **Lines**, evolving integration states move through the system as **Trains**, accepted units of work become **Cars**, review is handled by **Conductors**, movement is gated by **Engineers**, global coordination is handled by the **Dispatcher**, conflicts can be resolved by **Technicians**, and completed work ultimately converges on **Terminus**, representing the canonical state of the project.

The railway metaphor is not merely a visualization layer. Each concept corresponds to a concrete responsibility within the orchestration model.

> The railway is not a visualization of Git. It is the coordination model for many autonomous agents working on the same evolving codebase.

A Station is not an issue, a Train is not a branch, a Car is not a commit, and Terminus is not simply `main`.

- **Stations** describe goals and their declared intent.
- **Trains** are evolving integration snapshots that accumulate reviewed work.
- **Cars** record accepted work, its evidence, provenance, and review decision.
- **Lines** describe dependency and sequencing relationships.
- **Engineers** enforce the deterministic rules that decide whether a Train may move.
- **The Dispatcher** plans and coordinates the whole network.
- **The map** is a projection of orchestration state, not the owner of that state.

The aim is to operate one level above individual code changes: to keep a whole project moving while many agents complete interdependent goals at once.

---

# Project Intent

Modern coding agents are increasingly capable of working autonomously, but coordinating many agents introduces a different class of problems:

- determining which work can happen concurrently
- managing dependencies between tasks
- preserving context between related tasks
- reviewing autonomous changes before integration
- understanding what each agent changed and why
- forecasting collisions between separate workstreams
- resolving integration conflicts
- keeping humans informed without overwhelming them
- safely converging many independent changes back into one canonical codebase
- making long-running agent activity understandable while it is still in progress

Terminus treats multi-agent development as a traffic coordination problem.

The goal is not simply to visualize Git activity differently. The goal is to provide an orchestration model where isolated agent work can move through a structured network, be reviewed incrementally, accumulate safely, and eventually integrate into the project's canonical state.

The railway network should also make otherwise invisible background activity legible. A Train moving between Stations communicates that a workstream is active without pretending to expose a literal percentage-complete value that the system does not know.

---

# Design Principles

## Domain State Comes First

The railway model is part of the application domain, not something invented by the UI.

Concepts such as Trains, Stations, Lines, Cars, movement states, reviews, dependencies, and conflicts must exist independently of any particular renderer.

The orchestration state drives the map. The map never drives orchestration by mutating its own local interpretation of project state.

## The UI Is a Projection

The primary interface is a **2D network map** showing the current state of the railway.

The map renders semantic state supplied by the orchestration layer: where Trains are, which Stations are active or waiting, which Lines are blocked, and where attention is required.

Animation exists to communicate state changes. It is not itself a state machine and must not determine when work begins, completes, or integrates.

There is no requirement for a 3D engine or Three.js. The map should remain lightweight and implementation-independent from the orchestration model.

## Roles Own Responsibilities

Each agent role has a narrow responsibility. Agents should not become generic autonomous processes that can mutate any part of the system.

The Dispatcher plans and coordinates. Station Agents implement. Conductors review and manage their Train. Engineers gate movement. Technicians resolve exceptional integration problems.

## Deterministic Rules Are Not Delegated to Models

Mechanical safety and consistency rules are enforced by application logic. Models may interpret ambiguous situations and recommend actions, but they never override a deterministic gate such as failed required tests, an unresolved conflict, a missing dependency, or a user-imposed hold.

Provider and model selection are configuration concerns. The domain should depend on agent **roles and capabilities**, not on a particular model name or vendor.

## Declared Intent Helps Plan; Actual Changes Decide

Work Manifests provide structured intent before work starts.

Once work exists, the actual repository state, changed files, contracts, test evidence, and resulting diff are authoritative. Terminus should compare declared intent with actual results rather than assuming the manifest perfectly predicts implementation.

---

# Git and Cloudflare Artifacts

Terminus does not attempt to replace Git.

Git remains the underlying version-control model used by agents, development tools, and the orchestration system. Commits, diffs, history, merges, and other familiar Git concepts remain available underneath the railway abstraction.

Terminus builds a higher-level coordination model on top of Git using **Cloudflare Artifacts**.

Cloudflare Artifacts provides Git-compatible, programmatically managed repositories. An Artifacts repository has its own Git history, references, remote URL, access credentials, and durable state while remaining accessible through standard Git clients and workflows.

Artifacts repositories can be created and forked programmatically, making repositories practical as temporary units of isolation rather than only long-lived project containers.

At a high level:

```text
Terminus
Canonical Artifacts repository
        │
        │ fork
        ▼
Train
Isolated evolving integration repository
        │
        │ derive workspace at departure
        ▼
Station
Isolated implementation repository
```

A Train therefore does not need to be represented merely as a conventional Git branch.

It can maintain its own isolated repository and Git history while carrying the accumulated accepted work for its Line.

A Station Agent operates in a repository derived from the Train's exact current state without directly modifying the Train itself.

When the Station's work is accepted, its reviewed changes are incorporated back into the Train and recorded as a Car.

This creates a natural hierarchy of isolated working states:

```text
Terminus
    │
    ├── Red Train
    │     ├── Station A workspace
    │     ├── Station B workspace
    │     └── Station C workspace
    │
    ├── Blue Train
    │     ├── Station D workspace
    │     └── Station E workspace
    │
    └── Green Express
          └── Station F workspace
```

Each level can diverge independently while retaining its relationship to the exact state from which it originated.

The railway model describes **how work is coordinated**. Git and Cloudflare Artifacts provide the underlying versioned state that makes that coordination durable and inspectable.

---

# Core Concepts

## Terminus

**Terminus** represents the canonical state of the project.

Terminus is backed by the project's canonical Cloudflare Artifacts repository. Artifacts is the home of every managed project. Projects are imported from a Git URL, or created and pushed to directly. Code is retrieved with a standard `git clone`.

What defines Terminus is promotion:

- Station Agents never write directly to it.
- Conductors do not bypass the Train to write to it.
- A Train enters only after its exact accumulated state has passed the required integration checks.

Every Train's code baseline is a known Terminus state, and every Train ultimately runs toward Terminus with its accumulated work.

Terminus is the sole final convergence point for development occurring across the network.

### Network Topology

On the map, Lines radiate outward from Terminus. Each Line begins at a distant **depot**, passes through its Stations in order, and ends at Terminus.

```text
Depot ──→ Station A ──→ Station B ──→ Station C ──→ Terminus
```

A Train is created at its Line's depot and runs inward toward Terminus. It never travels out from Terminus and back again.

This creates a deliberate gap between the map and the repository model. In the repository model, the Train's repository is forked from the current Terminus state when the Train is created, even though on the map the Train starts at the far end of its Line. Conceptually, the Train's baseline "teleports" out to the depot. This is intentional: the map shows the direction of work (toward convergence), while the repository model shows where the code came from.

---

## Dispatcher

The **Dispatcher** is the primary orchestration agent and the central point of interaction between the user and the agent network.

The Dispatcher coordinates work rather than directly implementing product code.

Its responsibilities include:

- interpreting high-level development goals
- decomposing goals into Stations and Work Manifests
- laying out Lines and Stations, and creating their Trains
- establishing dependencies between Stations and between Lines
- determining which work can run concurrently
- assigning Station Agent roles or configurations
- maintaining the overall network state (topology, cross-Line dependencies, network-level holds)
- reasoning across Work Manifests to forecast likely collisions between Lines
- comparing declared scope with actual changes as work completes
- holding, rerouting, or sequencing Lines when dependencies or forecasts change
- receiving issues raised by Trains and deciding how to respond
- dispatching Technicians when conflict resolution is requested
- surfacing decisions or exceptions that require human attention

The Dispatcher should be the user's primary conversational interface to the system.

### Dispatcher vs Train Responsibilities

The Dispatcher does **not** micromanage individual Trains.

Each Train is responsible for its own state. It moves through its Line under its Conductor and Engineer: departing, waiting on Station work, docking, reviewing, attaching Cars, and departing again. The Dispatcher does not need to be involved in any of these routine steps.

When a Train hits something it cannot resolve within its own Line, it raises an issue to the Dispatcher through its Engineer (see [Engineers](#engineers)). Examples include repeated Station failures, a conflict with another Line, a blocked dependency, or a decision that needs the user. The Dispatcher then decides whether to reroute, hold, dispatch a Technician, revise a manifest, or alert the user.

Lower-level agents report through this structure rather than independently interrupting the user for routine activity.

The Dispatcher acts through defined domain commands and transitions. It should not bypass the domain model or mutate UI state directly.

### One Role, Two Halves

The Dispatcher is one conceptual role, but its implementation has two distinct halves:

- **Network state and coordination (deterministic).** This half records topology, applies Dispatcher commands as domain transitions, receives issues raised by Trains, and persists authoritative network state. It is ordinary application code.
- **Planning and judgement (model-driven).** This half handles conversation with the user, goal decomposition, manifest drafting, collision forecasting, and deciding how to respond to escalations. It proposes domain commands. It does not hold state.

A model's output never *is* network state. It becomes state only after being validated and applied as a domain command.

---

## Rail Lines

A **Line** represents an ordered development workstream.

A Line contains one or more Stations and has a Train travelling through them.

Lines express dependency and integration order rather than conventional Git branching.

For example:

```text
Red Line

Database Schema → API → Integration Tests → Terminus
```

Other Lines may contain only a single independent task:

```text
Green Express

Documentation → Terminus
```

Multiple Lines may operate concurrently.

A Line is allowed to change as the project evolves. The Dispatcher may hold, reorder, add, remove, or reroute Stations when new dependencies or conflicts are discovered, provided the resulting changes remain visible to the user.

---

## Trains

A **Train** represents the accumulated, reviewed integration state of a Line.

When a Train is created, it starts from the exact canonical project state that existed at that moment. On the map it begins at its Line's depot (see [Network Topology](#network-topology)).

In the repository model, the Train is its own Artifacts repository, forked from that Terminus state.

Each Train is responsible for its own state. Its Conductor manages the Train and its Cars, and its Engineer gates its movement. The Dispatcher is involved only when the Train raises an issue it cannot resolve within its own Line.

As Stations are accepted, their work is incorporated into the Train in order.

The Train therefore becomes the continuously evolving integration snapshot for its Line.

```text
Initial Train

🚂
```

After one accepted Station:

```text
🚂━🚃
   Database
```

After another:

```text
🚂━🚃━🚃
   DB  API
```

The Train acts as the handoff mechanism between sequential tasks.

Each new Station workspace is derived from the Train's latest accepted state, allowing downstream tasks to naturally inherit upstream work without reconstructing project context from scratch.

The Train should retain enough identity to answer questions such as:

- which Terminus state it departed from
- its current repository/tree state
- which Cars it carries and in what order
- which Station it is travelling toward or docked at
- which review or integration gate is currently blocking it

### Train States

| State | Meaning |
| --- | --- |
| `ready` | Stopped at its depot or at a Station, with all accepted work attached. Waiting for its Engineer to clear departure. |
| `in_transit` | Has departed toward the next Station, whose work is currently active. This means "work in progress", not a progress percentage. |
| `approaching` | The destination Station is `ready_for_pickup`. The Train is making its final approach. |
| `docked` | At a Station platform but not under active review. This covers arrival before review starts, and waiting while the Station Agent works on a revision. |
| `reviewing` | The Conductor is actively reviewing the Station's work against the Train. |
| `held` | Deliberately stopped by a known, expected condition: a user hold, Dispatcher sequencing to avoid a forecast collision, or an unmet dependency the Engineer is waiting on. A held Train resumes when the condition clears, with no intervention needed. |
| `blocked` | Cannot proceed because something went wrong, such as a conflict, repeated failure, failed required gate, or a decision needing the user. A blocked Train needs intervention from a Technician, the Dispatcher, or the user. |
| `returning` | All of its Line's Stations are complete, and it is on the final leg to Terminus. This includes Terminus integration checks. |
| `unloaded` | *Terminal.* Its work has been integrated into Terminus. The Train is removed from the map, and its Cars stay in the history. |
| `siding` | *Terminal.* The Train was abandoned and moved to the siding: a separate area of the map where it stays visible and inspectable but no longer runs. |

There is no separate "departing" state. Departure is the event (`train.departed`) that moves a Train from `ready` to `in_transit`.

---

## Stations

A **Station** represents a clearly defined Task or Goal.

Examples might include:

- add a database model
- implement an API endpoint
- build a UI component
- add authentication middleware
- write integration tests
- update documentation

Each Station has an associated **Station Agent** responsible for implementing its goal.

A Station is defined by a structured **Work Manifest**, not only a prose prompt.

The Work Manifest should capture information such as:

- goal
- expected behaviour
- scope
- expected areas of the codebase
- paths or areas to avoid
- contracts the Station adds, changes, or depends on
- relevant APIs, schemas, symbols, or interfaces
- invariants that must remain true
- dependencies on other Stations
- expected outputs
- acceptance criteria
- expected validation evidence
- known assumptions

The manifest gives the Station Agent a precise definition of the work and gives the Dispatcher structured information for dependency and collision analysis.

Declared intent is not treated as proof of what happened. Once a Station proposes work, its actual changes are compared with the manifest and unexpected scope is surfaced to the reviewer.

The authoritative manifest is domain state, stored in D1. A copy may be placed in the Station workspace as context for the agent, but that copy is never a second source of truth.

### Station States

| State | Meaning |
| --- | --- |
| `waiting` | Defined on its Line. No Train has departed toward it yet. |
| `signaled` | A Train has departed toward it. Its workspace is being derived from the Train's state and its Station Agent is being started. |
| `active` | The Station Agent is implementing and validating the manifest. |
| `ready_for_pickup` | The Station Agent has finished and its proposed work is committed. Waiting for the Train. |
| `in_review` | The Conductor is reviewing the proposed work. |
| `revising` | The Conductor returned the work with feedback, and the Station Agent is making another pass. On completion it goes back to `ready_for_pickup`. |
| `blocked` | Cannot continue without intervention, such as an agent failure, a request for user input, a conflict, or repeated rejection. |
| `complete` | The work was accepted and attached to the Train as a Car. |
| `cancelled` | Removed from its Line by a Dispatcher reroute. Kept for history rather than deleted. |

`signaled` is kept separate from `active` because deriving a workspace and starting a Sandbox can take time and can fail on their own, before any agent work begins.

### Station Workspace Timing

A Station workspace is created from the Train's current accepted state **when the Train departs toward that Station**, not after the Train arrives.

This is important to the network model: the Station Agent works while the Train is travelling.

The Station's isolated workspace may change freely during implementation without changing the Train's accepted state.

---

## Station Agents

A **Station Agent** performs the implementation work associated with a Station.

The Station Agent receives:

- the Station's Work Manifest
- the isolated repository state derived from the Train
- relevant project-level instructions and capabilities
- feedback from the Conductor when revision is required

Its responsibility is narrowly scoped to completing the Station's goal.

A Station Agent may:

- inspect the existing codebase
- modify code
- create files
- run tests
- perform validation
- commit changes
- collect implementation evidence
- provide a structured summary of the completed work

The Agent does not need to understand the wider railway implementation. It works in an ordinary Git-compatible environment.

When the Agent believes the task is complete, the Station becomes **Ready for Pickup**.

The Station Agent does not directly integrate its work into the Train.

---

## Conductors

Each Train has a **Conductor**. The Conductor is in charge of the Train: it protects the coherence of the Train's integration state and manages every Car the Train carries.

The Conductor determines whether work produced at a Station should be accepted onto the Train. When it accepts work, the Conductor attaches the resulting Car. The repository operation itself goes through the Artifacts layer, but the decision and its ownership belong to the Conductor.

Where practical, the Conductor should be configured with a different model family from the Station Agent, so that implementation and review do not share the same model biases. This is a configuration choice, not a domain dependency.

The Conductor reviews the Station against both its declared intent and its actual effect on the current Train state.

A Conductor may review:

- the Work Manifest
- proposed code changes
- the exact difference between the Train state and Station state
- files and symbols changed
- contracts added or modified
- tests and validation evidence
- type checking results
- linting or static analysis
- implementation quality
- unexpected or out-of-scope changes
- regressions
- whether acceptance criteria have been satisfied
- whether the proposed work is still compatible with Cars already on the Train

The separation between Train and Station repositories provides the natural review boundary.

If work is rejected, the Conductor returns structured feedback to the Station Agent. The Station enters `revising` and the Train waits `docked`.

If work is accepted, the reviewed Station state is incorporated into the Train and recorded as a new Car. Within a Line this is always a fast-forward, because the Station was forked from the Train's latest commit. If the Train has moved since then (for example, because of a Technician patch), the work is reviewed again against the new Train state rather than force-merged.

If the problem is a conflict or an unusual integration failure, the Conductor raises it to the Dispatcher. The Dispatcher may dispatch a Technician.

The Conductor protects the Train. It does not perform the Station Agent's implementation work on its behalf.

---

## Engineers

Each Train has an **Engineer** responsible for the Train's operational movement. The Engineer controls the signals.

Unlike the other roles, the Engineer is primarily **deterministic**. It applies hard domain rules, and may consult a lightweight decision model only for genuinely ambiguous operational choices. It is never an open-ended, general-purpose agent.

Responsibilities include:

- deciding whether the Train may depart, continue, wait, retry, or stop
- checking that the next Station's dependencies are satisfied
- reacting to Station and Conductor states
- enforcing holds
- routing recoverable problems toward a Technician (through the Dispatcher)
- raising issues to the Dispatcher when the Train cannot proceed on its own

Hard rules always win. No model output can override them:

```text
Failed required tests        → Train cannot depart
Unresolved conflict          → Train cannot depart / integrate
Dependency incomplete        → dependent Station cannot be signaled
User-imposed hold            → Train cannot proceed
Conductor rejected the work  → work returns to the Station
```

For choices the hard rules don't settle, the Engineer uses a decision model (by default Cloudflare's Clef). Clef returns a probability for each of a fixed set of answers, so the Engineer can act when confident and escalate when it isn't. The model runs only after the hard gates pass.

### The Engineer Is the Train's Voice to Dispatch

The Engineer is how a Train reports to the Dispatcher. It notifies the Dispatcher when:

- it reaches a gate the Dispatcher controls, such as entering Terminus or waiting on a Station in another Line
- something is wrong, such as being blocked, held for a long time, or failing repeatedly
- its decision model judges that the Dispatcher should know

Routine movement is not reported. Examples are clearing a normal departure, or waiting at a Station whose work isn't ready yet.

This controls only what the Dispatcher *hears*, never what is *recorded*. Every state change still writes its domain event, so the map and audit trail always show the full picture.

Signals on the map are a projection of the Engineer's current gate decision for that Train: green when cleared, red when `held` or `blocked`. Signals are not a separately stored piece of state that could disagree with the gates.

---

## Cars

A **Car** represents one accepted unit of work carried by a Train.

Each Car corresponds to a completed Station and records the semantic history of why the Train changed.

A Car should retain enough provenance to reconstruct the decision, including information such as:

- Station identity
- Work Manifest
- Station Agent identity/configuration
- source Train state
- accepted repository/tree state
- accepted commits
- files and symbols changed
- contracts added or changed
- code diff
- validation and test evidence
- optional preview or runtime evidence
- implementation summary
- Conductor review
- acceptance decision
- timestamps

A Car is primarily a domain record stored in D1. It does not need its own Artifacts repository. It references the accepted Git state on the Train repository, which remains the actual integrated filesystem.

Cars make the accumulated state of a Train understandable.

Rather than seeing only a collection of anonymous commits, a user can inspect the Train as a sequence of accepted development goals.

The underlying Git history remains available, but Cars provide a higher-level semantic history oriented around intent, implementation, evidence, and acceptance.

Cars may later support capabilities such as selective rollback, audit history, replay, deeper review, or provenance-aware debugging.

---

## Technicians

A **Technician** is a specialized agent used when normal Station execution or Train integration cannot proceed safely without reconciliation work.

Typical uses include:

- resolving merge conflicts between evolving Train states
- reconciling incompatible contracts or schemas
- adapting one workstream to changes introduced by another
- repairing integration failures discovered near Terminus
- producing a focused compatibility patch

A Technician should not silently rewrite canonical state.

Its output should be treated as another reviewable candidate change with clear provenance and evidence. Where appropriate, the affected Conductor should revalidate the resulting Train state before it continues.

The Dispatcher decides when Technician work is necessary and whether human involvement is required.

---

# Train Movement and the Work Loop

Train movement is intentionally connected to agent activity.

The old mental model of "Train arrives, then work begins" is replaced by a model where **departure starts the next unit of work** and travel represents that work being active.

A typical lifecycle is:

```text
Depot / current Station              Train: ready
        │
        │ Engineer clears departure (dependencies, holds, gates)
        ▼
train.departed                       Train: in_transit
        │
        ├── station.signaled         Station: signaled
        │     └── workspace derived from current Train state
        └── station.started          Station: active
        │
        ▼
Train is IN_TRANSIT ───────────────┐
        │                          │
        │                    implementation
        │                    + validation
        │                          │
        │                          ▼
        │            station.ready_for_pickup
        └──────────────────────────┘
                   │
                   ▼
train.approaching                    Train: approaching
                   │
                   ▼
train.arrived                        Train: docked
                   │
                   ▼
review.started                       Train: reviewing / Station: in_review
                   │
          ┌────────┴────────┐
          │                 │
       Accepted          Rejected
          │                 │
          ▼                 ▼
    car.attached      station.returned
    Station: complete  Station: revising, Train: docked
          │                 │
          ▼                 └──→ Station Agent revises
    Train: ready                  │
          │                       └──→ ready_for_pickup → review repeats
          ▼
   next Station, or train.returning → Terminus
```

### Movement Is Semantic, Not a Timer

`in_transit` means that the Train is en route to work that is currently being performed.

It does **not** mean the system knows that the task is 30%, 60%, or 90% complete.

The UI is free to animate the Train continuously while the Station is active, but the domain transition to `approaching` occurs because the Station becomes ready for pickup, not because a visual timer expires.

This makes the network feel alive without presenting fake progress information.

### Sequential Handoff

After a Station is accepted, the Train contains the newly reviewed Car before the next Station workspace is created.

The next Station therefore starts from the latest accepted Train state.

This gives sequential tasks a natural handoff path while preserving isolation for unfinished or rejected work.

### Blocking and Failure

If a Station becomes blocked, fails, or requires user input, the network state should reflect that condition explicitly. The Train becomes `held` or `blocked`, and the Train raises the issue to the Dispatcher.

The Dispatcher may hold the Train, reroute work, revise the Line, dispatch a Technician, or surface the decision to the user.

Visual movement should never hide a real orchestration blocker.

---

# Concurrency

Multiple Lines may operate at the same time.

```text
Green Express:  ◇ ─ Documentation ──────────────────┐
                                                    │
Red Line:       ◇ ─ Schema ─ API ─ Tests ───────────┼──→ Terminus
                                                    │
Blue Line:      ◇ ─ Profile UI ─ E2E Tests ─────────┘

◇ = depot, where the Line's Train is created
```

Each Line runs independently toward Terminus. Lines do not branch. Configured Crossings allow one-way pickup at a source Station: the receiving Train merges its exact accepted checkpoint, copies missing original Cars, and continues on its own Line. Terminus remains the final canonical convergence point.

Concurrency is one of the primary reasons the Dispatcher exists.

The system should not assume that different Lines are independent merely because they use different repository copies.

The Dispatcher can use structured intent from Work Manifests to forecast possible collisions before implementation finishes, including overlapping:

- files or directories
- APIs
- database schemas
- shared symbols or interfaces
- configuration
- invariants
- dependencies

As work completes, those predictions are refined using actual changes.

Potential conflicts can therefore be surfaced before two Trains both reach Terminus.

A collision forecast does not necessarily mean work must stop. The Dispatcher may sequence the Trains, hold one Line, modify a downstream Work Manifest, or request compatibility work.

---

# Returning to Terminus

After its last Station is complete, the Train enters `returning` for its final leg to Terminus.

A Train approaching Terminus is treated differently from a Train approaching an ordinary Station.

The Train is already an accumulated reviewed integration state, but the canonical project may have changed since it departed.

Before entry, Terminus should evaluate the Train's exact current state against the current canonical state and required project-wide checks.

This may include:

- detecting divergence since departure
- checking compatibility with other recently integrated Trains
- running project-wide validation
- reviewing unresolved collision forecasts
- reconciling canonical changes when necessary
- requesting Technician work or human intervention when automatic convergence is unsafe

The Engineer notifies the Dispatcher when the Train is ready to enter Terminus, because the Dispatcher decides the order in which returning Trains integrate.

Integration uses **merge commits, never rebase or squash**. Cars reference their accepted commits, and rewriting history would break their provenance. Conflicts are never force-merged. They become an issue raised to the Dispatcher, which may dispatch a Technician.

Only the final accepted Train state is promoted into the canonical project. The Train is then `unloaded`. A Train selected for human approval waits beforehand in the review yard as `held` with an `awaiting_user_approval` reason. Approval covers its exact accepted commit, and integration still validates the merge against current Terminus. A review wait does not reserve integration clearance. If integration is abandoned instead, the Train moves to the `siding`.

Terminus is therefore the sole canonical writer even though many isolated repositories may be active across the network.

---

# Application Architecture and Ownership

The implementation should preserve a hard boundary between **domain logic**, **orchestration**, **agent execution**, **repository operations**, and **presentation**.

The project should not accumulate important behavior in miscellaneous scripts or UI event handlers.

## Domain Layer

The domain layer owns the meaning of Terminus concepts.

It should define things such as:

- Projects (one managed codebase, backed by one canonical Terminus repository)
- Networks (the Lines, Trains, and Stations for a Project, coordinated by one Dispatcher)
- Trains
- Stations
- Lines
- Cars
- Work Manifests
- Engineer gate rules
- reviews
- conflicts
- network states
- valid transitions
- domain events
- invariants

This layer should not depend on React, map rendering, Cloudflare APIs, model vendors, or Git command execution.

It answers questions such as:

- Can this Train depart?
- What does `ready_for_pickup` mean?
- Is this transition valid?
- What state follows an accepted review?
- What information must a Car contain?

## Orchestration Layer

The orchestration layer coordinates the running system.

It owns workflows such as:

- creating Lines and Stations from Dispatcher decisions
- running each Train's own lifecycle (Engineer gates, departure, Conductor review, Car attachment)
- starting Station work on departure
- persisting authoritative network state
- responding to Station completion events
- routing issues raised by Trains to the Dispatcher
- holding or rerouting Trains
- coordinating retries and long-running operations
- triggering final Terminus integration

Long-running execution mechanisms such as Cloudflare Workflows belong here. They execute the process; they do not redefine the domain rules.

## Agent Runtime

The agent runtime translates domain roles into concrete model/tool executions.

Station Agents and Technicians run inside a Sandbox through an existing coding-agent harness (by default OpenCode), wrapped behind a runner interface. The Dispatcher, Conductor, and Engineer models are called directly and return structured output. See `technology-architecture.md` for the execution flow.

It should provide a consistent interface for invoking roles such as:

- Dispatcher
- Station Agent
- Conductor
- Technician
- Engineer (only its lightweight decision model for ambiguous operational choices; its hard rules live in the domain)

Specific providers and models remain configurable behind this interface.

Changing the model used by a Station Agent should not require changing the Train, Station, or map domain models.

## Artifacts / Repository Layer

The repository layer owns interactions with Cloudflare Artifacts and Git-compatible state.

It is responsible for operations such as:

- creating the canonical project repository
- deriving Train repositories
- deriving Station workspaces from exact Train states
- retrieving diffs and changed paths
- recording exact tree or commit identities
- applying accepted Station work to Trains
- preparing Train state for final integration

The rest of the application should work with meaningful repository operations rather than scattering raw Git or Artifacts calls throughout unrelated modules.

## Protocol Layer

Shared contracts between the backend, agents, and frontend should live in a dedicated protocol boundary.

This includes serializable representations of:

- network snapshots
- domain events
- commands
- agent requests/results
- Work Manifests
- review results
- progress/status messages

The protocol layer prevents the frontend from depending directly on backend implementation details and prevents agent adapters from inventing ad-hoc response shapes.

## Web / Map Layer

The web application owns presentation and interaction.

It should:

- render the 2D rail network
- display Trains, Cars, Stations, Lines, signals, blockers, and review states
- show project and task detail panels
- present user decisions and exceptions
- animate state changes
- send explicit commands or user decisions back to the orchestration layer

It should **not**:

- decide whether a Train may depart
- infer that a Station is complete from an animation
- perform repository merges
- run agent workflows directly from arbitrary components
- contain duplicate orchestration rules
- become the authoritative source of network state

---

# 2D Network Map

The primary interface is a **2D map of the rail network**.

The map exists to make orchestration state spatial and understandable, not to simulate a realistic railway.

A Train's visible position should be derived from its semantic state (see [Train States](#train-states)): `ready`, `in_transit`, `approaching`, `docked`, `reviewing`, `held`, `blocked`, `returning`, `unloaded`, and `siding`. Station markers likewise come from [Station States](#station-states). Signals come from the Engineer's gate decisions.

Lines are drawn radiating outward from Terminus. Trains appear at their Line's depot and move inward. Unloaded Trains leave the map. Abandoned Trains move to a separate siding area.

The renderer may use SVG, Canvas, DOM elements, or another lightweight 2D approach. That choice must not leak into the domain model.

The map should be capable of representing multiple concurrent Trains and should visibly distinguish normal movement from states requiring attention.

Detail views can expose the deeper semantic information behind a map object: a Train's Cars, a Station's Work Manifest, a Conductor's decision, or a conflict forecast.

---

# State and Events

Terminus should behave as an event-driven state machine rather than a collection of loosely related callback scripts.

Representative events may include:

```text
line.created
line.rerouted
train.created
train.departed
train.approaching
train.arrived
train.held
train.released
train.blocked
train.issue_raised
train.returning
train.unloaded
train.sided
station.signaled
station.workspace_created
station.started
station.ready_for_pickup
station.returned
station.blocked
station.cancelled
review.started
car.attached
conflict.detected
conflict.resolved
technician.dispatched
terminus.integration_requested
terminus.integration_completed
```

The exact event vocabulary can evolve, but events should describe meaningful domain changes.

Naming conventions:

- Events use `entity.past_tense_or_state` in snake_case, for example `car.attached`.
- State values are lowercase snake_case, for example `in_transit`.
- When choosing between a generic name and a railway-metaphor name, prefer the metaphor. For example, use `car.attached` rather than `review.accepted`, and `station.signaled` rather than `station.activated`.

The UI receives these changes by polling an ordered event log. It does not invent them locally. Each event is written in the same atomic step as the state change it describes. Delivery details are in `technology-architecture.md`.

This event model also provides a durable audit trail and creates clean integration points for logs, previews, notifications, and future observability features.

---

# Recommended Project Structure

A practical high-level repository structure is:

```text
apps/
  web/
    components/
    map/
    views/
    state/

  worker/
    api/
    agents/
    workflows/
    integrations/

packages/
  domain/
  protocol/
  agent-runtime/
  artifacts/
  ui/
```

The exact filenames are less important than the ownership boundaries.

The specific technologies (React + Vite, shadcn/ui, Workers, Workflows, D1, Artifacts, Sandboxes, Workers AI + AI Gateway), and which one owns each kind of state, are defined in `technology-architecture.md`.

Unit tests live next to the code they test, inside each package or app. A top-level `tests/` directory is only for cross-package integration and end-to-end tests.

## `packages/domain`

Pure railway/orchestration concepts, state transitions, invariants, and domain events.

This is the source of truth for what the system means.

## `apps/worker`

Cloud runtime entry points and orchestration.

It exposes APIs, runs durable workflows, invokes agent roles through the agent runtime, persists network state, and coordinates integrations.

## `packages/agent-runtime`

Common abstractions and adapters for invoking configured AI models in defined roles.

## `packages/artifacts`

Cloudflare Artifacts and Git-facing repository operations.

## `packages/protocol`

Serializable contracts shared across process boundaries.

## `apps/web`

The user-facing application and 2D network map.

Local frontend state may manage presentation concerns such as selection, open panels, zoom, filters, and temporary interaction state. It should not duplicate the authoritative orchestration state machine.

## `packages/ui`

Reusable presentation components that are not specific to orchestration ownership.

### Avoid Catch-All Logic Directories

A generic `/scripts` directory should not become the place where core behavior lives.

Scripts may exist for true one-off maintenance or development tasks, but runtime behavior should have a named owner in the domain, orchestration, agent runtime, Artifacts integration, or UI layers.

---

# Human Oversight

Terminus is intended to increase autonomous throughput without making important decisions invisible.

The user should not need to approve every routine transition, but the system should surface decisions where human judgment materially matters.

Examples include:

- a Dispatcher wants to materially alter the requested scope
- two Trains have a semantic conflict with no clearly safe automatic resolution
- a Station repeatedly fails its acceptance criteria
- a Technician proposes a significant reconciliation change
- final integration would overwrite or invalidate recently accepted canonical work
- project-level policy requires explicit approval

Routine progress should remain visible through the map and detail views without turning every agent action into an interruption.

---

# System Boundary

Terminus is responsible for **coordination, isolation, review, movement, provenance, and convergence**.

It is not intended to:

- replace Git
- replace coding agents' existing development tools
- make the UI renderer the orchestration engine
- equate repository branches directly with railway concepts
- use visual animation as proof of execution progress
- hide unresolved conflicts behind automatic merges
- tie architectural roles permanently to one AI provider or model

The central idea remains simple:

> Work begins at Stations, reviewed value accumulates on Trains, the Dispatcher keeps the network coherent, and only accepted integration states return to Terminus.

The 2D railway map makes that process understandable, but the orchestration model remains authoritative even when no UI is connected at all.

## Crossing integration boundary

Crossings are first-class, one-way pickup visits in ordered Line routes. Source Stations retain one implementation owner and a frozen acceptance checkpoint. Cars copied onto receiving Trains preserve their origin and commit identities; compatibility review and merged-candidate evidence are recorded separately. The shared Integration Workflow reserves one target repository, prepares and validates an isolated candidate, and promotes the exact reviewed commit. Only the receiving Train Workflow records pickup completion and changes that Train's state. Terminus remains the sole canonical project state. See README and AGENTS.md for configuration, failure handling, and demonstration instructions.

## Junctions

A Junction is a feature convergence point: fixed incoming Lines end there, their Trains merge into its separate repository, and human release creates one outgoing Train toward Terminus. Its feature brief is a domain object. All inputs start from a frozen Terminus baseline. Multiple independent Junctions are permitted; V1 has no nesting, baseline refresh or partial release. Complete feature validation and Conductor review follow all input acceptances. Junction unloading is destination-aware and does not change canonical Terminus. Outgoing Lines may have zero or more Stations; the released Train carries accumulated original Car provenance plus integration/repair references. [Junctions](junctions.md) defines the lifecycle, ownership and recovery rules.
