# Terminus integration

How returning Trains are cleared, merged, validated and promoted into canonical Terminus.

## Clearance

The deterministic Dispatcher clears the oldest eligible returning Train. Holds and unresolved conflicts keep the entry gate closed. D1 reserves one active integration attempt per network; the reservation has no expiry, so a slow or restarted Workflow cannot race another canonical writer. Every attempt has its own Integration Workflow and durable input, candidate, evidence and result. Only the Train Workflow changes the Train's state.

## Merge, validation and promotion

Each attempt forks a candidate repository from the current recorded Terminus commit, fetches the exact accepted Train head, and merges with `--no-ff`. The canonical commit is the first parent and the Train head is the second. The adapter verifies that the original Terminus baseline and every Car's accepted commit remain in history. It never rebases, squashes or force-merges. A Train already contained by Terminus needs no new merge; its current canonical state is still validated.

Project-wide validation runs in a fresh Sandbox checkout of the saved candidate, with read access to that repository and no model access or canonical write capability. Orchestration runs `npm ci` and every configured project command, collects actual exit codes and bounded output, and checks that validation did not change the candidate. Missing, failed or truncated evidence stops promotion. Passing evidence is checkpointed in D1 before a separate Git workspace obtains write access to Terminus.

Promotion pushes exactly the validated candidate using a non-forced fast-forward of the canonical ref, guarded against an unexpected remote head. The commit being pushed is a merge commit, preserving all accepted Car identities. D1 then records the new canonical head and completed attempt atomically and releases clearance. A second returning Train prepares against that new head. A lost push acknowledgement is recovered by checking the canonical Git head before attempting another write; a lost result event is recovered from D1 by the Train Workflow.

## Conflicts and recovery

Conflicts become durable open conflict records, and the Train raises an issue to the Dispatcher. Failed integration validation also blocks the Train. After intervention, clear the blocked Train to start a new attempt; resolving a conflict record does not itself repair code, so unresolved Git conflicts will be detected again. A hold placed before promotion defers the attempt and holds the Train; releasing it resumes the Train automatically. To have a Technician reconcile a failed merge, see [Technician repairs](technician.md).

After repairing an integration issue:

```sh
curl -X POST http://localhost:8787/api/networks/NETWORK_ID/conflicts/CONFLICT_ID/resolve
curl -X POST http://localhost:8787/api/trains/TRAIN_ID/clear
```

If Artifacts is unavailable while an uncertain promotion is being reconciled, clearance stays reserved and the Train receives an explicit integration blocker. The attempt retains its active status with an interruption result. Inspect the attempt and the Integration Workflow status, then use the retry endpoint once the Workflow is `errored`. Recovery clears the interruption, asks the blocked Train Workflow to resume, and restarts the same attempt with its D1 candidate and evidence intact. It reconciles the canonical head before another push. Do not manually delete active reservations.

```sh
curl http://localhost:8787/api/networks/NETWORK_ID/integrations
curl -X POST http://localhost:8787/api/integrations/INTEGRATION_ID/retry
```

## Setup

The new `0003_integration.sql` migration and `INTEGRATION_WORKFLOW` binding are required. Local dev commands apply migrations automatically. For a deployed Worker, apply migrations and deploy the updated Worker through the maintainer workflow before testing a fresh demo network. New integration requires no additional model configuration or calls.
