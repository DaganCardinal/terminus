# Ten-Train stress test

The quickest judge-facing flow is built into Terminus. Open **Stress test** from the Networks page, select **Run ten-Train stress test**, watch the map, then select **Verify and download report** when all ten Trains have unloaded. The browser uses the normal app login; no Access token needs to be copied into a terminal.

## One-command local rehearsal

After the normal `npm ci` setup, run:

```sh
npm run stress:ten
```

This builds the web app, runs the ten-Train scenario through local D1 and real local Workflows, checks duplicate launch recovery and frozen execution, and runs a real temporary local Git oracle with ten merges and deliberately incorrect file contents. It needs Node 24 and Git. It does not need Docker, a Cloudflare account, project import, model credentials, or an Access token. It is explicitly a local rehearsal: it does not measure live Artifacts or Sandbox capacity.

To watch the rehearsal in the app, start `npm run dev:fake` and `npm run dev:web` as usual, then open **Stress test**. The report identifies simulated execution and does not claim a verified canonical Git tree.

## Full Cloudflare verification

Deploy the current code using the ordinary [live setup](live-setup.md), open the app, and run the test from **Networks → Stress test**. The app's normal Cloudflare Access login still applies; local development against real infrastructure can use the same page at localhost. There is no deployment-wide stress variable to enable, and ordinary Networks can continue using their configured agents.

The explicit backend command:

1. Creates a separate Project and Artifacts namespace with a bundled npm fixture, committed lockfile, and working TypeScript/Vitest checks. No public fixture URL or manual baseline push is required.
2. Prepares all ten Train repositories from the same baseline, then atomically records all Lines, Stations, Trains, unload policies, events, and frozen test execution configurations.
3. Starts the ordinary Train Workflows with stable identities. Station and integration execution follows the existing pipeline.

Keep the normal default Sandbox limits (ten agent, ten agentless) for the first baseline measurement. The test uses deterministic Station edits and Conductor decisions while retaining real Artifacts, Git, repository-scoped access, Sandboxes and their capacity gates, D1, Workflows, independent validation, sealed candidate integrity checks, fast-forward Station acceptance, and merge-commit integration. Every Station adds a checkpoint module and test under `src/terminus-stress/<run UUID>/`. Each versioned manifest must match the fixture exactly. Provenance identifies scripted execution explicitly; no model calls are needed for these roles. The advisory conflict watch also uses offline triage and investigation for this scripted fixture; canonical integration still validates the real merges. The immutable `execution_configs.pipelineStress` field scopes the override to the launched Trains and survives later settings changes or deployments.

The browser displays progress and submits commands. Closing or refreshing it cannot change Train movement or acceptance; Workflows continue headlessly. Final verification is an explicit read-only command, so refreshing the page does not start another Git oracle or affect the lifecycle. Its downloaded report contains the run identity, final snapshot, durable events, per-Train work and queue durations, integration service time, maximum queue depth, total drain time, and integrations per minute.

The Cloudflare oracle clones canonical Terminus in an agentless Sandbox and verifies:

- Exactly ten completed Stations, unloaded Trains, and Cars from one baseline, with the fixture manifests, scripted provenance, and passing independent evidence.
- Exactly twenty expected regular Git blobs with exact contents and no other baseline-to-final changes.
- Every accepted Car commit remains reachable from the canonical head.
- Exactly ten canonical merge commits, matching the unloaded Trains' recorded commits.
- Exactly ten completed integration attempts, no failed or active attempts, and no live or expired capacity leases after verification.

The repository's actual Git head must match the recorded snapshot, and the Network must remain unchanged during verification. An unexpected retry, revision, blocker, missing timing evidence, overlapping reservations, incorrect file, or leftover resource prevents a passing report. The local app rehearsal performs the metadata/timing checks with simulated repositories and returns no Git verification; it labels that distinction in the UI and report.

Results remain inspectable as an ordinary Network. Use the usual explicit **Delete Network** action when its evidence is no longer needed. Nothing is deleted automatically.

## Launch recovery

A launch uses a UUID request identity with stable Network, repository, Line, Station, and Train identities. Repeating that same request recovers Workflow starts without creating more Lines or accepting work twice. The browser keeps a pending identity in session storage and reuses it if launch fails, including after refreshing. An atomic batch makes the ten-Line topology visible together.

A launch interrupted before that batch may leave prepared repositories in its deterministic namespace. Retrying the same request reuses them. After the batch, the Network appears in the usual list even if the client lost its response. A new test uses a fresh identity and namespace.

## Advanced CLI

The CLI remains available for automation and detailed API/performance sampling. First inspect the scenario without contacting a service:

```sh
npm run stress:ten -- --dry-run
```

For a configured real Worker:

```sh
npm run stress:ten -- \
  --base-url https://YOUR-APP-ORIGIN \
  --output stress-runs/first-ten \
  --timeout-minutes 30
```

It now creates the fixture Network automatically. `--network NETWORK_ID` optionally selects an existing empty, compatible Network. Protected live CLI requests still require `CF_ACCESS_TOKEN`, an Access login JWT for an allowed maintainer email. This is an advanced CLI authentication option; the browser flow never asks for it. Tokens are sent only to the selected origin, redirects are refused, and credentials are never journaled. Local real-infrastructure Workers use `http://localhost:8787` without live Access authentication.

The CLI writes `run.json`, `scenario.json`, `events.json`, `report.json`, and `perf.json`. It exits nonzero on a correctness failure or deadline and does not retry mutations automatically. Its report also includes API latency and the existing Perf Tail records, grouped by phase when available. Tail delivery can lag, and `complete=false` identifies an incomplete window. Missing perf data does not invalidate the correctness oracle. The browser report focuses on durable event timings and correctness.

Resume an observer after a successful launch:

```sh
npm run stress:ten -- --observe stress-runs/first-ten
```

Observation does not replay launch commands. A failed launch can be recovered by submitting its saved `runId` as the same request identity to the launch endpoint. Do not generate a new identity to recover an old launch.

## API

All endpoints use normal application authentication:

- `GET /api/stress-test`: configured repository mode and fixture version.
- `POST /api/stress-tests`: `{requestId,networkId?}`; creates/recovers a test and returns its Network, run identity, baseline, and mode.
- `GET /api/networks/:id/stress-test/run`: reconstructs the immutable run identity.
- `GET /api/networks/:id/stress-test`: lease and integration counts.
- `POST /api/networks/:id/stress-test/report`: verifies and returns a downloadable report; explicitly identifies simulation.
- `POST /api/networks/:id/stress-test/verify`: advanced canonical Git oracle with `{runId,baseline}`; simulated execution returns no Git result.

This first fixture is conflict-free and has one Station per Line. Crossings, Junctions, deliberate failures, and model-provider throughput remain later scenarios. Establish service times before setting a performance budget; canonical integration is deliberately serialized.
