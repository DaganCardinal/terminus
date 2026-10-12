# Technician repairs

When a Terminus merge fails with actual conflict paths, open the Dispatcher and choose **Dispatch Technician**. The Train stays blocked while a Technician works in a separate Artifacts repository. The harness can write only that repository and can read the affected Train; it receives no Terminus write capability or model credential. The Worker uses `TECHNICIAN_MODEL` through the existing outbound Gateway handler.

This first slice handles one Train's failed Terminus merge and limits repair edits to the recorded conflicted files. Clean automatic merge results must remain intact. Broader compatibility patches, Station recovery, and automatic repair revisions are not implemented. A rejection or execution failure requires an explicit fresh dispatch. A changed conflict set also stops the repair for intervention.

## Review and approval

The Worker constructs a merge commit with the original Terminus and Train commits as its two parents, preserving accepted Car identities. It persists the candidate before running project-wide validation in a fresh, read-only Sandbox and submitting the actual full integration diff and reconciliation diff to the affected Conductor. The Dispatcher shows the checks, Conductor findings, diffs, and provenance. Choose **Approve repair and integrate** only after reviewing those results.

Approval records the exact source snapshots. A stale candidate cannot promote: dispatch a fresh Technician to reconcile against current Terminus. Unrelated conflicts and user holds still gate integration. The final integration process confirms that the Train and repair repositories still hold the exact reviewed commits and promotes exactly that commit. Everything the Technician's inspection verified (parents, ancestry, scope, diffs) follows from those commit IDs, so it is not derived again. The repair's independent evidence stands in for a second validation run only when it passed every configured check with the same commands. Otherwise integration validates the candidate again. Only successful promotion resolves the linked conflict; the Train Workflow then unloads the Train. Rejected candidates, feedback, failed validation evidence, and source provenance remain inspectable.

## Setup

Restart the updated Worker to load `TECHNICIAN_WORKFLOW` and `TECHNICIAN_MODEL`. Local dev applies `0007_technician.sql` automatically. Remote migration and deployment remain maintainer actions. No additional secret is required.

To exercise the flow offline, set `FAKE_INTEGRATION_CONFLICT_PATHS` in the `env.fake.vars` section of `apps/worker/wrangler.jsonc` to `src/App.tsx`, restart `npm run dev:fake`, and lay demo Lines in a new network. Every ordinary fake integration will report that scripted conflict; the fake Technician follows the same persisted review and explicit approval path. Set the value back to the empty string for ordinary fake integration. Fake diffs and checks are simulations and incur no model charges.

## API

```text
POST /api/networks/:networkId/conflicts/:conflictId/technician
POST /api/networks/:networkId/repairs/:repairId/approve
```

Repair history is included in `GET /api/networks/:networkId` snapshots, and `technician.*` changes use the existing domain event feed. Execution continues with no browser connected; the approval command is the only user gate.
