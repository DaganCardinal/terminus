# Browser Run transport gate

## Status

The deployed transport proof passed: a Cloudflare Sandbox connected through outbound interception to hosted Chromium, loaded a private candidate application, clicked it, made subsequent requests on the same CDP connection, and captured a screenshot.

This satisfies the transport release requirement only. Agent browser tools, project browser configuration, independent browser checks and model image-capability handling are not yet implemented. Keep `BROWSER_RUN_ENABLED=false` outside explicit proof runs until the remaining implementation below is complete.

## Transport and isolation

`POST /api/browser-run/proof` uses the existing agent Sandbox infrastructure and Cloudflare Access protection described in [deployment](../README.md#deployment). It creates a fresh throwaway Sandbox and runs the bundled candidate application and Playwright Core client from `/opt/browser-run`. No Artifacts repository or model access is granted.

The proof has three required stages:

| Stage | Verification |
| --- | --- |
| `sandbox_websocket_interception` | A WebSocket round trip reaches the container Durable Object's native `fetch()` through outbound interception |
| `remote_browser_cdp` | Playwright connects to the hosted Browser binding's CDP WebSocket |
| `private_application` | A scoped outbound Fetcher loads the private candidate, handles a click and subsequent requests, verifies the per-run identity and captures a screenshot |

The candidate listens on fixed port 3000 and is exposed to Chromium only as `candidate.terminus.test`. Browser guardrails restrict navigation to that host. Browser credentials and the binding remain outside the container. Only bounded stage results and screenshot metadata leave it; image pixels stay in the disposable Sandbox.

Browser requests require both the Worker feature flag and the Sandbox's `allowBrowser` grant. With the flag off, the proof endpoint returns 404 and browser transport routes refuse access. The proof is bounded at two minutes, browser sessions use a 60-second keep-alive, and cleanup closes the session and purges the Sandbox. A crashed proof container idles out after five minutes.

WebSocket upgrades must use the container Durable Object's native `fetch()`; RPC cannot serialize the socket response. The adapter returns a bare 101 response with the socket to avoid duplicate handshake headers. The scoped candidate Fetcher and browser session are created in the same invocation. Reconnection must create a new session and Fetcher together; Fetchers are not persisted between invocations.

The internal CDP WebSocket travels between the Sandbox, its container Durable Object and the Browser binding. It does not require a public WebSocket route through Worker-level Access. Implementation lives in `apps/worker/src/integrations/browser-run.ts`, `execution-sandbox.ts` and `apps/worker/browser-run`. The agent image bundles Playwright Core without browser binaries.

## Run the deployed proof

These commands are a maintainer deployment procedure. From the repository root, enable the proof without changing the checked-in default:

```sh
npm run deploy -- --var BROWSER_RUN_ENABLED:true
```

Wait for the deployed agent image to be ready. Open the app, sign in through Access, and run this in the browser console:

```js
await (await fetch("/api/browser-run/proof", { method: "POST" })).json()
```

A cold Sandbox can take a minute or two. The response contains `{ passed, sandbox, durationMs, stages, error?, exitCode?, stderr? }`. Only `passed: true` with all three stages successful satisfies the proof. Logs can be inspected with `npx wrangler tail` from `apps/worker`.

After the proof, deploy again without the override:

```sh
npm run deploy
```

This restores the disabled default.

## Local diagnostics

The saved probes in [`scripts/browser-run-transport`](../scripts/browser-run-transport) are optional one-off diagnostics and must not be deployed. They need Docker and Wrangler authentication; their remote Browser binding can incur usage. They do not import the application Worker, use D1 or Artifacts, or call models.

From the repository root, start the Sandbox probe:

```sh
CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID npm exec --workspace @terminus/worker -- wrangler dev --config ../../scripts/browser-run-transport/wrangler.jsonc --port 8792
```

In another terminal:

```sh
curl --silent --show-error --max-time 75 -X POST http://localhost:8792/prove
```

The supplementary edge-only probe uses `edge-wrangler.jsonc` with `wrangler dev --remote --port 8793`; invoke its `/prove` endpoint with a 45-second timeout. Exit each Wrangler session with `x` to close its remote-binding connection.

Local remote-binding transport could not serialize the session WebSocket or accept the scoped candidate Fetcher; the supplementary remote preview could not expose its loopback entrypoint. These development limitations are why the complete proof runs in a deployed Worker. The local probes remain useful for reproducing transport failures, but do not replace the passed hosted proof.

## Remaining implementation

1. Build on the proof's Browser binding, `BROWSER_RUN_ENABLED` gate, `allowBrowser` grant and fixed application port: add operation/generation-scoped grants, fixed application-port routing, lazy app/browser lifecycle, session cleanup and a 30-minute absolute deadline.
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
