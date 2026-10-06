# 01 — Two Lines, no conflict

**Target:** 2 Lines. One Line has a single Station and the other has up to 6. Both Trains integrate into Terminus cleanly.

## Prompt

```text
Two things for Supportdesk this round. They're unrelated and can ship separately.

1. Customer directory sorting and plan filter (small)
On the Customers page, let me sort the table by clicking the Customer, Company, Tickets, Open and Customer since column headers. Clicking the same header again reverses the order, and the active column and direction should be visible, with aria-sort for screen readers. Add a plan filter (All plans / Starter / Pro / Enterprise) next to the search box that works together with search. Keep this self-contained to the Customers page: reuse the existing select and table styling from the Tickets page rather than adding new CSS, leave the shared sample data alone, and put its tests in their own test file next to the Customers page instead of the main App test file.

2. Ticket tags (larger)
Agents want to label tickets with short tags like "bug", "refund" or "onboarding". This is a bigger change, so I'd like it to land in small steps that each build on the previous one and can be reviewed on their own:
  a. Add tags to the ticket model and give the 20 sample tickets a sensible spread of tags. Show them as chips on the ticket detail page.
  b. Show tags in the Tickets table, and in the compact recent-tickets table on the dashboard (truncate after two with a "+N").
  c. Let agents add and remove tags from the ticket detail page, session-only like other ticket edits. Normalise to lowercase and ignore duplicates.
  d. On the Tickets page, add a tag filter that combines with the existing search, status and priority filters, and make search match tags too.
  e. Add a "Top tags" panel to the dashboard showing the most-used tags across open and pending tickets. Each tag links to the Tickets page filtered by that tag.
  f. Add a Tags section to Settings where an admin can rename or delete a tag across every ticket. Reset demo data should restore the original tags.
Each step should come with tests for what it adds.

Everything stays client-side and in memory like the rest of the demo: no backend, no persistence beyond the session, no external services.
```

## What to check in the proposal

- **Customers** Line: 1 Station. Expected areas are limited to `src/features/support/customers.tsx` and a new test file.
- **Tags** Line: ideally 6 Stations in a–f order. Getting 4 or 5 is also likely, because the planner may merge (a)+(b) or (c)+(d).
- No collision forecast between the two Lines. If the Customers manifest lists `src/index.css`, `src/data/support.ts` or `src/App.test.tsx`, re-propose, because those files are where a conflict would come from.

## If it misses

- **Tags collapses to 2–3 Stations:** add "Please keep these as six separate, individually reviewable steps; I'll review each before the next starts."
- **Customers gets merged into the Tags Line:** add "These two are owned by different people and should not wait on each other."
