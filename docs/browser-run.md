# Browser Run transport gate

## Status: waiting on a deployed transport proof

The approved design uses Cloudflare-hosted Chromium, Playwright over CDP, and a trusted local MCP adapter for Station Agents, Technicians, and Conductors. Its first release requirement is an actual Sandbox → outbound interception → Browser Run → private candidate application proof, including a click, later requests on the same connection, and a screenshot.

That proof did **not** pass on October 8, 2026. Browser support is unavailable in production; no project configuration, MCP tools, browser checks, or model capability changes have been enabled. The existing harnesses and alternative-harness release gate are unchanged. The implementation must remain disabled until the transport requirement passes.

The repeatable development probes are in [`scripts/browser-run-transport`](../scripts/browser-run-transport). They are one-off diagnostics, not production infrastructure, and must not be deployed. They do not import the application's Worker, use D1, access Artifacts, call models, or change any managed repository. Their Sandbox class exists only in local Wrangler storage. The remote Browser binding can incur browser usage.

## Recorded results

Tested with Node 24.18.0, Wrangler 4.147.0, the Cloudflare Sandbox 1.0.0 shim, and Playwright Core 1.64.0. Docker was available and Cloudflare authentication succeeded in the maintainer-selected account.

| Check | Result |
| --- | --- |
| Local Sandbox connects to a private `wss://browser.terminus.test/echo` endpoint through HTTPS outbound interception | Passed; message round trip verified |
| Playwright connects through interception to a remote Browser binding's session-pinned CDP Fetcher | Failed: `Can't serialize a Response containing a webSocket.` |
| Browser binding launches with a same-invocation scoped local Worker entrypoint in `outboundByHost` | Failed: `BrowserBindingError: outboundByHost["candidate.terminus.test"] must be a Worker binding or entrypoint stub (status=400, code=2000)` |
| Supplementary edge-only `wrangler dev --remote` with scoped `ctx.exports.CandidateOutbound({ props })` | Failed before launch: `ctx.exports.CandidateOutbound is not a function`; the export was `undefined` |
| Private candidate loading, click, subsequent private requests, and screenshot | Not verified |

The edge-only attempt included `enable_ctx_exports` and an explicit `exports.CandidateOutbound` declaration. Neither resolved the missing loopback entrypoint in that preview environment. It has no Sandbox and could not satisfy the complete release requirement even if it passed.

These are observed development-transport failures, **not proof that a fully deployed Worker cannot support the design**. The local remote-binding proxy rejects the private Fetcher and cannot transfer the session-pinned WebSocket response. The edge preview does not expose the scoped entrypoint used by the design. A full deployed proof using the existing `ExecutionSandbox` ownership model remains necessary. Wrangler's current remote-development path does not run containers, so `dev --remote` cannot replace that end-to-end test.

One additional transport constraint was confirmed while constructing the probe: return WebSocket upgrades through a Durable Object's native `fetch()` method. A custom RPC method cannot serialize the WebSocket response. The saved probe uses native `fetch()`.

Repository validation: typechecks, lint, formatting and build passed. The Worker suite passed all 189 tests after allowing its local workerd server to listen outside the filesystem sandbox. Web, agent-runtime, domain and protocol suites passed. The Artifacts suite passed 48 tests and hit one existing 5-second Git-test timeout; that test passed when rerun alone. All four probe JavaScript entrypoints passed Node syntax checks. Both saved live probes reproduced the failures above and their development sessions were shut down.

## Reproduce the Sandbox probe

Authenticate Wrangler, start Docker, and use the chosen account's ID. From the repository root:

```sh
CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID npm exec --workspace @terminus/worker -- wrangler dev --config ../../scripts/browser-run-transport/wrangler.jsonc --port 8792
```

In another terminal:

```sh
curl --silent --show-error --max-time 75 -X POST http://localhost:8792/prove
```

The Docker build runs `npm ci` against the probe's separate lockfile, installing **only `playwright-core`**, without browser binaries. There is no dependency installation during the Sandbox run. The application listens on fixed port 3000; the caller cannot select a Sandbox or port. The Browser binding and Cloudflare credentials stay outside the container. Browser guardrails allow only `candidate.terminus.test`, and the candidate route accepts only HTTP at that exact origin.

The response contains the process exit code and bounded stdout/stderr. Stdout is a JSON object with three named stages; every stage runs even if an earlier stage fails. Only `passed: true` with all three successful stages is a complete local proof. A failed connection is an error, never passing or skipped evidence.

The application stage navigates to `http://candidate.terminus.test`, clicks its button, fetches its state twice with a delay, verifies the per-run application identity, and captures PNG bytes with Playwright. On success it reports the generated path, dimensions, byte count, and SHA-256. Image pixels never enter the response or Worker logs. `/tmp/browser-proof.png` is disposable and disappears when the Sandbox is destroyed.

Each invocation owns a fresh local Sandbox. Browser replacement closes the previous session. `finally` closes the recorded browser session and destroys the container; a 90-second alarm handles interrupted requests, and Browser Run has a 60-second idle lifetime. Exit Wrangler with `x` after the probe to close its remote-binding development connection. Do not deploy this local-only configuration.

## Reproduce the supplementary edge check

This starts a temporary remote preview with only a Browser binding, no Containers or Durable Objects:

```sh
CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID npm exec --workspace @terminus/worker -- wrangler dev --remote --config ../../scripts/browser-run-transport/edge-wrangler.jsonc --port 8793
```

```sh
curl --silent --show-error --max-time 45 -X POST http://localhost:8793/prove
```

The saved diagnostic returns a bounded JSON error with the failed stage and entrypoint type. If the preview supports scoped loopback entrypoints, it attempts private navigation, a click, later requests, and screenshot capture using raw CDP. This isolates Browser Run's private-routing API from Sandbox transport. Exit Wrangler with `x`; do not deploy this diagnostic.

## Run the deployed proof

The local results above are limits of the development setups, so the transport question needs a real deployment. It will run inside the long-lived Terminus deployment described in [Deploying a private beta](private-beta-deployment.md), not as a separate Worker. That deployment's Cloudflare Access and in-Worker JWT verification protect it. The proof will use the existing `ExecutionSandbox`, behind `BROWSER_RUN_ENABLED=false` by default.

Worker-level Access refuses WebSocket upgrades. That does not affect this design: the CDP WebSocket travels between the Sandbox, its Durable Object and the Browser binding, never through a public route.

## Resuming implementation

First establish the full hosted proof using the existing Worker and `ExecutionSandbox`, without a new Durable Object or storage service. Keep control endpoints private to Sandbox outbound interception. Confirm that the scoped outbound Fetcher survives later application requests for the entire CDP connection. Reconnection must create a new session and Fetcher in one invocation. Cloudflare documents that Fetchers are not persisted between invocations.

Once that passes, the remaining approved implementation is:

1. Add the Worker Browser binding behind `BROWSER_RUN_ENABLED=false`, scoped Sandbox/operation/generation grants, fixed application-port routing, lazy app/browser lifecycle, session cleanup and a 30-minute absolute deadline.
2. Add Zod-defined project server/preparation/readiness/browser-check configuration, network API/settings, atomic D1 updates/events, and immutable execution snapshots through plans, Trains, revisions, Junctions, repairs and integration attempts. Historical missing configuration means disabled. Reject collisions with ordinary check names.
3. Bundle a trusted stdio Playwright Core MCP server into the Sandbox image. Enable it only for implementation, repair and review profiles across all three pinned harnesses; planning and `explore` receive no browser tools. Preserve repository isolation, filesystem restrictions and Conductor seals.
4. Resolve and freeze curated image-input capabilities. Return screenshots as MCP image content only for image-capable models, along with generated `/tmp` paths and dimensions. Enforce the 2 MiB inline limit, avoid caller-selected paths/uploads/local reads, and keep pixels out of Worker logs and Workflow results.
5. Run independent browser checks against the exact candidate after the harness exits, with fresh browsers and existing bounded evidence collection. Application/assertion failures fail required checks; service failures use infrastructure error/retry handling. Include requested baseline and integration/repair/Junction validation.
6. Verify adapter discovery, permissions, resume and real image payloads with mocked providers at the pinned CLI versions; validate isolation, lifecycle, candidate integrity and two concurrent demo runs. Add project setup and explicit `chromium.connectOverCDP()` Playwright Test fixture documentation.

Live agent verification initially uses OpenCode with GLM-5.3 Flash. Claude Code and Codex provider verification remains maintainer-authorized release work. The scope remains private HTTP application testing, serial browser checks per Sandbox and disposable screenshots; HTTPS-dependent features, public browsing, external-resource allowlists and application WebSocket guarantees are deferred.

## References

- [Browser Run outbound Workers and Fetcher lifetime constraints](https://developers.cloudflare.com/browser-run/features/outbound-workers/)
- [Browser binding session and connection API](https://developers.cloudflare.com/browser-run/reference/browser-binding-api/)
- [Browser Run guardrails](https://developers.cloudflare.com/browser-run/features/guardrails/)
- [Workers context, scoped loopback entrypoints, and compatibility flag](https://developers.cloudflare.com/workers/runtime-apis/context/)
- [Browser binding local development](https://developers.cloudflare.com/browser-run/reference/wrangler/)
- [Playwright CDP connection API](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
