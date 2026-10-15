# Crossings

A Crossing lets a Line pick up accepted work at another Line's Station, then continue on its own route. The source Train keeps running. Pickup includes the source Train's complete accepted Car prefix at that Station, including previously imported work, but excludes later Stations. The receiving Train keeps its own Cars and copies only missing original Cars.

## Demo

Run `npm run dev:fake` and `npm run dev:web`, create an empty Network, and select **Lay Crossing demo** in the Dispatcher. The Footer Line develops a component, accepts its tests (the checkpoint), and continues to a stylesheet Station. The Application Line builds a theme toggle, visits the Footer tests Station to pick up the first two Cars, then wires both components into App. Both Trains integrate into Terminus. Select the receiving Train to inspect Crossing attempts, candidate checks, compatibility review, and original Car links. The API/real-Workflow test verifies this flow without a browser.

## Routes

Line creation accepts an optional `route` alongside the existing full Station definitions. For a Line defining `theme-toggle` and `app-wiring`, add this route:

```json
{
  "route": [
    { "kind": "station", "key": "theme-toggle" },
    { "kind": "crossing", "source": { "kind": "existing", "stationId": "footer-tests-station-id" } },
    { "kind": "station", "key": "app-wiring" }
  ]
}
```

Supply full Work Manifests in `stations` as in the existing Line API examples. Dispatcher proposals can instead use `{ "kind": "planned", "stationKey": "footer-tests" }` to reference a Station in the same proposal. Every owned Station must appear once. New Lines may reference existing Stations; running routes cannot be edited. The backend rejects reciprocal Line flow and dependency cycles.

## Inspection and recovery

`GET /api/crossings/:crossingId` returns the frozen checkpoint, attempt history, checks, reviews, and Car provenance. `POST /api/crossings/:crossingId/retry` explicitly retries a blocked pickup. A failed handoff never reopens the source Station. Persistent incompatibility requires replanning or `POST /api/trains/:trainId/siding` with a reason; Crossing Technician repair is outside v1. Uncertain Git writes retain their reservation and prevent abandonment until recovery.

## Manual verification

Using the [live Artifacts/Sandbox setup](live-setup.md), lay the same demo in a fresh Network. Verify that the receiver's checkpoint is the accepted Footer tests commit, that no stylesheet Car was copied, that the App Station workspace starts from the Crossing merge commit, and that both Trains unload through independently validated Terminus merges. Inspect failures and retries through the Crossing detail endpoint. This procedure does not require publishing or deploying Terminus.
