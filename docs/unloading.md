# Automatic unloading and human approval

Each planned Line includes the Dispatcher's unloading recommendation and a short reason. Select **Auto-unload** or **Human approval** before launching; the persisted selection overrides the recommendation. You can also change a running Train's selection in its Line details until Terminus clearance is reserved.

Human approval affects only the final Terminus gate. Station execution, Conductor review, and Car attachment proceed normally. Once its Stations finish, the Train becomes `held` with an `awaiting_user_approval` reason and appears in the **Review yard**. Siding still means abandoned. Waiting for review never reserves integration clearance or prevents other eligible Trains from unloading.

Open the Train to review each accepted Car's diff, manifest, independent checks, and Conductor findings. In live mode, the existing preview button opens the Train's accepted application state (see [Previews](previews.md)). **Approve unloading** records permission for that exact Train commit; a changed Train requires fresh approval. This is approval of the Train, not a preview of its eventual merge with current Terminus. The integration Workflow still prepares a merge commit and independently validates it against current Terminus. Approval never overrides conflicts, failed checks, or other holds.

## Demo

The fixed demo starts **Red Line** with auto-unload and **Blue Line** with human approval. For the competition demo, launch both, let Red unload while Blue waits in the review yard, refresh to demonstrate persistence, review Blue, then approve unloading. Offline mode follows the same lifecycle with simulated evidence; application preview requires live execution. Model recommendations and live Artifacts/Sandbox integration of this gate still need a maintainer live check.

## API

```sh
# Change a saved proposal's selection before launch.
curl -X PUT http://localhost:8787/api/networks/NETWORK_ID/plans/PLAN_ID/lines/LINE_KEY/unload-mode \
  -H 'content-type: application/json' -d '{"mode":"human_approval"}'

# Change a running Train's policy before clearance.
curl -X PUT http://localhost:8787/api/trains/TRAIN_ID/unload-mode \
  -H 'content-type: application/json' -d '{"mode":"human_approval"}'

# Approve only the accepted commit shown in the reviewed snapshot.
curl -X POST http://localhost:8787/api/trains/TRAIN_ID/approve-unload \
  -H 'content-type: application/json' -d '{"trainCommit":"REVIEWED_TRAIN_COMMIT"}'
```

Migration `0008_unload_policy.sql` stores Dispatcher-owned permissions separately from Train state and closes approval/clearance races in D1. Existing Trains retain auto-unload. Local dev commands apply the migration; apply it remotely before deploying through the maintainer workflow.
