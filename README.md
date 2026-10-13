# Terminus

Terminus coordinates coding agents on concurrent Lines of work. Each Train accumulates accepted Station work; D1 owns the railway state, Artifacts owns repositories, and Workflows coordinate execution. The browser polls snapshots and the domain event log.

## Status

- **Implemented and live-verified:** the domain, persistence, API, Train/Station/Terminus integration Workflows, React/SVG railway map, and real Artifacts and Sandbox harness adapters (OpenCode by default) alongside fakes. The maintainer verified two concurrent Trains reaching and integrating into Terminus in a live test.
- **Implemented, awaiting live verification:** Dispatcher planning (read-only exploration → persisted proposal → explicit launch), sandboxed Conductor reviews, Technician reconciliation of failed Terminus merges, commit-bound human unloading approval, and the Engineer's Clef decisions on failed Station runs and revision loops.

## Quick start with fakes

Use Node 24 and npm. No Cloudflare credentials, Docker or model calls are needed for the fake environment.

```sh
npm install
npm run dev:fake
```

In another terminal:

```sh
npm run dev:web
```

Open the URL Vite prints. Create a network and choose **Lay demo Lines**. The two Trains run independently; the Red Line has two ordered Stations, and the Blue Line has one. Fake reviews request one revision by default. Accepted work appears as Cars with events in the status page. Returning Trains integrate one at a time and finish at `unloaded`. Red unloads automatically; Blue waits in the review yard until you approve its accepted changes.

The Dispatcher also offers **Lay Crossing demo** and **Lay Junction demo** in a fresh network.

## Checks

```sh
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
```

Worker tests run in workerd with D1 and Workflows. Repository transport tests use real, temporary local Git repositories. Model tests use mock transports; they do not incur inference charges. The current workerd Workflow tests can print cancellation messages during teardown even when assertions pass.

## Real repositories and agents

Live execution needs Docker, Cloudflare access to Artifacts and Sandboxes/Containers, two Worker secrets (`ARTIFACTS_API_TOKEN`, `AI_GATEWAY_TOKEN`), and a public HTTPS Git repository containing an npm project. Put local secrets in the ignored `apps/worker/.dev.vars`, start Docker, then run `npm run dev:worker` and `npm run dev:web`. Role harnesses and models are chosen in **Settings → Agents**; the default preset uses `@cf/zai-org/glm-5.3-flash` for every role.

See [Live setup](docs/live-setup.md) for token permissions, `.dev.vars`, harness and provider configuration, troubleshooting and deployment, and [Private beta deployment](docs/private-beta-deployment.md) for the live beta. Deployment is a maintainer action.

## Guides

| Guide | Covers |
| --- | --- |
| [Live setup](docs/live-setup.md) | Credentials, agents and models, provider routing, release gate, deployment |
| [Dispatcher planning](docs/dispatcher-planning.md) | Proposing, reviewing and launching plans; removing Stations; recovery |
| [Unloading and human approval](docs/unloading.md) | Auto-unload vs. review yard, commit-bound approval |
| [Station execution](docs/station-execution.md) | Station runs, evidence, revision allowance, Conductor review |
| [Terminus integration](docs/terminus-integration.md) | Clearance, merge/validate/promote, conflicts and recovery |
| [Technician repairs](docs/technician.md) | Reconciling failed Terminus merges |
| [Crossings](docs/crossings.md) | Picking up another Line's accepted work |
| [Junctions](docs/junctions.md) | Multi-Line feature convergence before Terminus |
| [Previews](docs/previews.md) | Previewing a Train or Terminus, preview hostnames |
| [Publishing](docs/publishing.md) | Publishing Terminus to a publish repository and deploying it with Workers Builds |
| [API examples](docs/api.md) | Creating networks, validation commands, snapshots and events |
| [Harness selection](docs/harness-selection.md) | Per-role harnesses, frozen configuration, release verification |
| [Browser Run transport gate](docs/browser-run.md) | Browser testing design, reproducible probes, current transport blockers |

Architecture and ownership rules are in [AGENTS.md](./AGENTS.md), [the outline](./docs/outline-updated.md), and [technology architecture](./docs/technology-architecture.md).
