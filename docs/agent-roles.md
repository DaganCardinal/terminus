# Agent Roles and Train Execution Flow

This document defines the primary agent roles in the system and the expected lifecycle of a Train as work moves between Stations.

The core principle is that **agents have distinct responsibilities**, while the Train provides the persistent execution context that carries accepted work through the network.

---

## Core Roles

### Dispatcher

The **Dispatcher** operates at the network level.

It understands the user's overall goal and is responsible for turning that goal into a structured execution plan.

Responsibilities include:

- Breaking a larger goal into Stations.
- Determining dependencies between Stations.
- Deciding which Stations can execute in parallel.
- Creating and assigning Trains.
- Maintaining awareness of work happening across the network.
- Detecting potential cross-Train conflicts or dependency changes.
- Escalating situations that require user intervention.
- Replanning when the state of the project changes significantly.
- Responding to issues raised by Trains.

The Dispatcher does not micromanage individual Trains. Each Train runs its own lifecycle under its Conductor and Engineer, and raises an issue to the Dispatcher only when it cannot resolve something within its own Line.

The Dispatcher should generally avoid implementing code directly.

Its job is to coordinate the system rather than perform Station-level work.

---

### Station Agent

Each active Station has a **Station Agent** responsible for completing that Station's Work Manifest.

The Work Manifest defines the intended outcome, relevant constraints, acceptance criteria, and project context for that Station.

Responsibilities include:

- Understanding the Station's Work Manifest.
- Inspecting the current artifact/project state.
- Implementing the requested changes.
- Running appropriate validation and tests.
- Recording important decisions and reasoning.
- Producing a structured summary of the work completed.
- Marking the Station as ready for pickup once the work is complete.

The Station Agent prepares the work.

It does **not** decide whether that work becomes part of the Train.

---

### Conductor

The **Conductor** travels with the Train and is in charge of it. It decides whether completed Station work should be accepted, and it manages every Car the Train carries.

When the Train arrives at a Station, the Conductor reviews the Station Agent's output.

Responsibilities include:

- Comparing the completed work against the Work Manifest.
- Reviewing code changes and generated artifacts.
- Checking validation/test results.
- Identifying unintended changes or scope creep.
- Comparing the work against the Train's current integration snapshot.
- Determining whether the Station's work is safe to accept.
- Rejecting work that requires further changes.
- Raising unusual problems to the Dispatcher, which may dispatch a Technician.

When work is accepted, it becomes part of the Train's evolving state.

Conceptually, the Train gains another **Car** representing the accepted work. The Conductor attaches it.

Where practical, the Conductor should use a different model family from the Station Agent so that implementation and review do not share identical model biases.

---

### Engineer

Each Train has an **Engineer** responsible for its operational movement. The Engineer controls the signals. A signal on the map is a projection of the Engineer's current gate decision, not a separately stored piece of state.

Unlike the other roles, the Engineer should primarily rely on deterministic system rules and lightweight decision models rather than an open-ended general-purpose LLM.

Responsibilities include:

- Determining whether the Train may proceed.
- Checking whether dependencies are satisfied.
- Responding to Station and Conductor states.
- Deciding when to continue, wait, retry, stop, or escalate.
- Routing recoverable problems to the Technician.
- Preventing movement when hard safety or consistency rules fail.

The Engineer should never override deterministic rules.

For example:

- Failed required tests → Train cannot depart.
- Unresolved conflict → Train cannot depart.
- Missing dependency → Train cannot proceed.
- User-imposed hold → Train cannot proceed.

Decision models such as Cloudflare Clef may be used for ambiguous operational decisions, while hard rules remain enforced by application logic.

The Engineer is also the Train's voice to Dispatch. It notifies the Dispatcher when the Train reaches a gate the Dispatcher controls (such as entering Terminus), when something is wrong, or when its decision model judges the Dispatcher should know. Routine movement is not reported, but every state change is still recorded as a domain event.

---

### Technician

The **Technician** handles exceptional or difficult situations that cannot be resolved through the normal Station → Conductor flow.

Responsibilities include:

- Resolving merge or artifact conflicts.
- Repairing failed integrations.
- Investigating repeated Station failures.
- Reconciling incompatible changes from multiple Trains.
- Fixing problems identified by the Conductor.
- Providing a resolution that can be reviewed and accepted back into the normal workflow.

Technicians should be used relatively rarely.

Normal implementation belongs to Station Agents; the Technician exists for situations where something has gone wrong or become unusually complex.

---

# Train Execution Flow

The Train acts as the persistent carrier of accepted project state.

A Train is created at its Line's **depot**, the far end of the Line. It moves through a sequence of Stations representing related units of work and finishes at Terminus. Trains always run *toward* Terminus. In the repository model, the Train's repository is still forked from the current Terminus state when the Train is created.

State names below follow the canonical lists in `outline-updated.md` ("Train States" and "Station States").

The important UX principle is:

> **Station work occurs while the Train is travelling toward that Station.**

The Train's movement therefore becomes a visual representation of ongoing work rather than merely transportation between completed tasks.

---

## 1. The Next Station Is Identified

The Line's plan identifies the Train's next destination.

Typical state:

```text
Train: ready
Station: waiting
```

The Engineer checks hard dependencies and holds before clearing departure. If a dependency is not yet satisfied, or a hold is in place, the Train becomes `held` until the condition clears.

---

## 2. Train Departs

Once the Engineer clears departure, the following happens as part of the same system transition:

```text
train.departed      Train → in_transit
station.signaled    Station → signaled
```

The Station's workspace is forked from the Train's current state, and its Station Agent is started. Once the agent begins work:

```text
station.started     Station → active
```

The Station does not need to wait for the Train to physically arrive before performing work.

---

## 3. Station Agent Works While Train Is En Route

While the Train is visually travelling:

```text
Train: in_transit
Station: active
```

The Station Agent may:

- inspect files,
- modify code,
- create artifacts,
- run tests,
- validate acceptance criteria,
- update its execution notes.

The Train animation represents an **indeterminate execution state**.

It should not imply a fake completion percentage or fixed journey duration.

If the Agent takes twenty seconds, the Train may travel for twenty seconds.

If the Agent takes several minutes, the Train remains visibly in motion while work continues.

---

## 4. Station Work Becomes Ready

When implementation and validation are complete:

```text
station.ready_for_pickup    Station → ready_for_pickup
```

The Train then transitions from generic travel into its final approach:

```text
train.approaching           Train → approaching
```

This allows the UI to synchronize the visible arrival with the actual completion of the work.

The Train should generally wait for the Station to become ready rather than arriving early and sitting idle while the Agent continues working.

---

## 5. Train Arrives

```text
train.arrived       Train → docked
```

As soon as the Conductor begins its review:

```text
review.started      Train → reviewing
                    Station → in_review
```

---

## 6. Conductor Reviews the Work

The Conductor compares the completed work against:

- the Work Manifest,
- acceptance criteria,
- tests and validation results,
- the Train's existing integration snapshot,
- relevant architectural or project constraints.

There are several possible outcomes.

### Accepted

```text
car.attached        Station → complete
```

The work is incorporated into the Train's evolving state.

Conceptually:

```text
Locomotive
  ├── Car 1: previous accepted work
  ├── Car 2: previous accepted work
  └── Car 3: newly accepted Station work
```

The Train's integration snapshot is updated accordingly.

### Revision Required

If the work is incomplete but straightforward to fix:

```text
station.returned    Station → revising
                    Train → docked
```

The Station Agent receives the review feedback and performs another implementation pass. When it finishes, the Station returns to `ready_for_pickup` and review repeats.

The Train waits at the platform (`docked`) until the work is acceptable.

### Technician Required

If the problem involves a conflict or an unusual integration failure:

```text
train.issue_raised  Train → blocked
```

The Conductor raises the issue to the Dispatcher, and the Dispatcher dispatches a Technician (`technician.dispatched`).

### Human Intervention Required

If the system cannot safely determine the correct resolution:

```text
train.issue_raised  Train → blocked
```

The Dispatcher surfaces the issue to the user.

---

## 7. Train Prepares to Depart

After the Station's work has been accepted:

```text
Station: complete
Train: ready
```

The Engineer checks:

- next-Station dependencies,
- Train health,
- unresolved conflicts,
- required validation,
- network-level holds.

If all required conditions pass, departure is cleared.

---

## 8. Train Departs for the Next Station

The cycle repeats:

```text
Train departs
        ↓
Next Station is signaled
        ↓
Station Agent works while Train travels
        ↓
Work becomes ready
        ↓
Train arrives
        ↓
Conductor reviews
        ↓
Car attached
        ↓
Train departs again
```

This continues until every Station on the Line is complete.

---

## 9. Train Returns to Terminus

```text
train.returning     Train → returning
```

The Train makes its final run to Terminus, where its accumulated state is checked against the current canonical state and project-wide validation.

- **Integrated:** the Train's work is promoted into Terminus, and the Train is **unloaded** (`train.unloaded`). It is removed from the map, and its Cars stay in the history.
- **Abandoned:** the Train is moved to the **siding** (`train.sided`), where it stays visible and inspectable but no longer runs.

---

# Parallel Trains

The Dispatcher may create multiple Lines, each with its own Train, when work can happen independently.

For example:

```text
Depot A ─ Station B ─ Station C ──┐
                                  ├──→ Terminus
Depot D ─ Station E ─ Station F ──┘
```

Both Trains can move and execute work concurrently.

This gives the network a clear visual representation of parallel execution.

Lines do not branch or merge into each other before Terminus. Terminus is the only convergence point.

The Dispatcher should forecast potential conflicts between Lines before they reach Terminus whenever possible.

---

# Held and Blocked Trains

Stopped Trains should also be represented through the railway model.

There are two different kinds of stop:

- **`held`**: stopped by an expected condition, such as a user hold, Dispatcher sequencing, or an unmet dependency. A held Train resumes on its own once the condition clears.
- **`blocked`**: stopped because something went wrong. A blocked Train needs intervention.

For example:

```text
Train in_transit
      ↓
Station encounters problem
      ↓
Signal turns red
      ↓
Train stops before Station (blocked)
      ↓
Train raises issue to Dispatcher
      ↓
Technician or user intervenes
```

Possible reasons for a Train to be blocked include:

- repeated Station failure,
- failed required tests,
- artifact conflict,
- incompatible changes from another Train,
- user intervention required.

Once resolved, the signal can return to green and the Train continues.

---

# Architectural Principle

The railway metaphor should represent the state of the system without becoming the system itself.

For example, avoid architecture where:

```text
Train animation finishes
→ therefore Agent execution begins
```

Instead, application state should drive both execution and visualization:

```text
Execution state changes
        ↓
Agent behaviour updates
        ↓
Train/Station visualization reflects that state
```

The frontend may represent a state transition as a Train leaving a Station, but orchestration should remain independent of the animation.

This keeps the underlying system reliable while allowing the railway visualization to become increasingly expressive over time.
