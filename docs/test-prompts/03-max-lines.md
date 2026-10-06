# 03 — Maximum Lines

**Target:** 8 Lines, each with 1–6 Stations and at most 24 Stations in total. The requested sizes add up to about 19, which leaves room under the cap.

## Prompt

```text
We're clearing the Supportdesk backlog. These eight requests are unrelated, owned by different people, and should all progress at the same time. None of them needs anything from the others.

1. Ticket tags (big, so land it in reviewable steps in this order): (a) add tags to the ticket model, give the sample tickets a sensible spread and show tags on ticket detail; (b) show tags in the Tickets table; (c) add and remove tags from ticket detail; (d) a tag filter on the Tickets page that combines with the existing filters, with search matching tags too; (e) a "Top tags" panel on the dashboard; (f) rename or delete a tag across all tickets from Settings.

2. Reports page (three steps): (a) a new Reports page in the sidebar with live breakdowns of the queue by status, priority and category; (b) a per-teammate workload table with open and pending counts; (c) a "Download CSV" button that exports those breakdowns, generated in the browser.

3. Bulk triage on the Tickets page (three steps): (a) row checkboxes with select-all-on-this-page and an "N selected" bar; (b) bulk change status and priority for the selection; (c) bulk reassign, then clear the selection and show a confirmation message.

4. Saved replies (two steps): (a) a Saved replies section in Settings with a few starter replies that agents can add, edit and delete for the session; (b) an "Insert saved reply" picker next to the ticket reply box that fills in {first_name} with the customer's first name.

5. Keyboard shortcuts (two steps): (a) "g" then "h", "t", "c" or "s" to jump to Dashboard, Tickets, Customers or Settings, "/" to focus the current page's search, and "n" to open New ticket. None of them should fire while typing in a field, and the existing "D" theme shortcut must keep working. (b) A "?" help dialog that lists every shortcut, including "D".

6. Customer directory (small): sortable column headers with aria-sort, plus a plan filter next to the search box.

7. New ticket dialog (small): let agents pick the category and assignee instead of always using General and Alex Morgan.

8. Ticket detail navigation (small): Previous and Next links on the ticket detail page that follow the queue's newest-first order and show the position, such as "3 of 20".

Everything stays client-side and session-only like the rest of the demo, with no backend, persistence or external services. Each change should come with tests for what it adds.
```

## What to check in the proposal

- 8 Lines. Rough Station counts: Tags 5–6, Reports 2–3, Bulk triage 2–3, Saved replies 2, Shortcuts 1–2, Customers 1, New ticket 1, Ticket navigation 1.
- At most 24 Stations in total. If the planner pushes past 24, the schema refuses the proposal, so trim item 1 to five steps.
- Collision forecasts are expected (`tickets.tsx` for Tags, Bulk triage and Ticket navigation; `ticket-detail.tsx` for Tags, Saved replies and Ticket navigation). This prompt isn't trying to avoid conflicts.

## If it misses

- **Two small items merged into one Line** (often 6 and 7, or 5 and 8): add "Please keep all eight separate; each has its own owner and review."
- **Tags flattened to 2–3 Stations:** add "Item 1 should be six individually reviewable steps."
