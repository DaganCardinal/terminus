# Dispatcher test prompts

Goals to paste into **Dispatcher → Propose a plan** on a fresh Network imported from `terminus-demo-app` (the Supportdesk demo). Each prompt tries to steer the planner toward a particular network shape without naming Lines, Stations or Junctions. Model output varies, so check the proposal before launching and re-propose if the shape is wrong.

| File | Target shape |
| --- | --- |
| [01-two-lines-no-conflict.md](01-two-lines-no-conflict.md) | 2 Lines, 1 and 6 Stations, no integration conflict |
| [02-four-lines-with-conflict.md](02-four-lines-with-conflict.md) | 4 Lines with 1–6 Stations, at least one Terminus merge conflict |
| [03-max-lines.md](03-max-lines.md) | 8 Lines, 1–6 Stations each, at most 24 Stations |
| [04-lines-then-junction.md](04-lines-then-junction.md) | Two goals on one Network: several small Lines, then a Junction with 4 incoming Lines and an outgoing Line with Stations |

## How the prompts steer the planner

The levers come from `packages/agent-runtime/src/dispatcher-prompt.ts`:

- **Separate Lines** come from work that is described as unrelated and owned by different people. The planner keeps genuinely independent work concurrent even when it touches the same files.
- **More Stations on a Line** come from a numbered sequence where each step builds on the previous one and produces something reviewable on its own. The planner merges steps that are too small, so every step needs a concrete deliverable.
- **One-Station Lines** come from requests framed as small and self-contained.
- **Junctions** are only proposed "when the user requests feature isolation". Prompt 04 asks for the feature to be built separately as one unit, reviewed as a whole and signed off before it is connected to the app.
- **Conflicts:** collision forecasts are shown, but they do not block launch. A real conflict happens at Terminus integration when two Trains edit the same lines of the same file, such as the sidebar `navigation` array, the `Page` union in `route.ts`, the nav-label list in `App.test.tsx`, or the end of `index.css`.
- **Avoiding conflicts:** the no-conflict prompt keeps its small change inside one page and asks for its tests in a separate test file.

Every prompt keeps the work client-side and in memory, like the rest of the demo. None of them asks for a backend, persistence or external data.

## Limits to keep in mind

- At most 8 Lines, 6 Stations per Line and 24 Stations in total, counting Junction incoming and outgoing Stations.
- The goal text can be up to 4,000 characters, and every prompt here fits.
- A Junction needs at least two incoming Lines. Its outgoing Line can have zero Stations, so prompt 04 asks for follow-up work after release.
