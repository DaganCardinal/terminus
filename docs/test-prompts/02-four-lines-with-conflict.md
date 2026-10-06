# 02 — Four Lines with a conflict

**Target:** 4 Lines with Station counts spread across 1–6. At least one Train hits a real Git conflict when it integrates into Terminus.

## Prompt

```text
Here's this week's batch of Supportdesk requests. They came from different people, don't depend on each other, and I don't want any of them waiting on the others, so get them all moving at once.

1. Reports page (from our team lead)
Add a Reports page to the sidebar navigation, between Customers and Settings. To start, it should show how the current queue breaks down by status, priority and category, calculated from the live in-memory tickets so it updates when tickets change. Next, add a workload table showing each teammate's open and pending ticket counts and their highest-priority open ticket. Finally, add a "Download CSV" button that exports those breakdowns as a CSV file generated in the browser.

2. Saved replies (from our senior agent)
Add a Saved replies page to the sidebar navigation, between Customers and Settings, listing a handful of starter canned responses (a greeting, asking for more details, closing a resolved ticket). Agents can add, edit and delete saved replies for the session. Then, on the ticket detail page, add an "Insert saved reply" picker next to the reply box that fills in the reply and replaces {first_name} with the customer's first name.

3. New ticket dialog (quick fix from support ops)
New tickets are always created as "General" and assigned to Alex Morgan. Let the agent choose the category (from the categories already used by the sample tickets) and the assignee in the New ticket dialog, keeping the current values as defaults.

4. Internal notes and ticket history (bigger, from our QA lead)
Agents need to leave notes for each other on a ticket without the customer seeing them. Please build this in steps that are each reviewable on their own:
  a. Add an "Internal note" mode to the ticket detail reply box. Notes appear in the conversation with a clearly different look and an "Internal" label.
  b. Record status, priority and assignee changes as history entries on the ticket and show them inline in the conversation timeline.
  c. Add a conversation view switch: Everything / Customer conversation / Internal only.
  d. Show a small notes indicator with a count in the Tickets table for tickets that have internal notes.
  e. Let an agent pin one internal note. The pinned note shows at the top of the ticket details sidebar.
  f. Allow editing and deleting internal notes written by the current agent. Customer messages stay read-only.

Update the existing app tests wherever navigation or the conversation changes, and add tests for the new behaviour. Everything stays client-side and session-only like the rest of the demo, with no backend or external services.
```

## Why this should conflict

Requests 1 and 2 each add a page "between Customers and Settings". On separate Trains, each one edits the same spots from the same baseline:

- The `navigation` array and the `route.page === …` render block in `src/App.tsx`.
- The `Page` union and the `parseRoute` branch in `src/features/support/route.ts`.
- The nav-label list in the first `App.test.tsx` test, which both requests are told to update.
- The tail of `src/index.css`, if both append styles.

Requests 2 and 4 also both change the reply form in `ticket-detail.tsx`, which adds a second chance of a conflict.

The planner will probably forecast these collisions. Forecasts are shown but do not block launch, and the planner prompt keeps independent work concurrent even when it shares files. The first of these Trains to integrate succeeds, and the second records a conflict that can go to the Technician.

## What to check in the proposal

- 4 Lines. Rough Station counts: New ticket dialog = 1, Saved replies = 2, Reports = 2–3, Internal notes = 4–6.
- Collision forecasts on `src/App.tsx` / `route.ts` between Reports and Saved replies. That's the goal, so launch anyway.
- If Reports and Saved replies end up on **one** Line, the conflict won't happen. Re-propose.
- Set every Line to **Auto-unload** so both conflicting Trains reach the Terminus gate without waiting for approval.

## If it misses

- **Reports and Saved replies are serialized:** add "Reports and Saved replies are owned by different people and should be built independently. I'll deal with any overlap at merge time."
- **No textual conflict after integration** (Git merged cleanly): a Technician can't be exercised without one. Fall back to `FAKE_INTEGRATION_CONFLICT_PATHS` in fake mode, or re-run. Two inserts at the same array position conflict almost every time.
