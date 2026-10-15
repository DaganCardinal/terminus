# 04 — Several Lines, then a Junction

**Target:** two goals submitted one after the other on the same Network.

- **Goal A:** several ordinary Lines, each with a few Stations (about 4 Lines × 2–3 Stations).
- **Goal B:** a Junction with at least 4 incoming Lines. Its outgoing Line has at least 1 Station before it reaches Terminus.

Launch Goal A first, then submit Goal B while those Trains are still running. Goal B then also exercises the Dispatcher's handling of existing active Lines. It works on its own on a fresh Network too.

## Goal A: several Lines with a few Stations each

```text
A few independent improvements to the Supportdesk ticket workflow. They're unrelated and owned by different people, so none of them should wait on another. Each one has a couple of steps that build on each other and should be reviewable separately.

1. Bulk triage on the Tickets page
  a. Add row checkboxes with select-all-on-this-page and an "N selected" bar above the table.
  b. Let staff change the status and priority of every selected ticket at once.
  c. Add bulk reassign, then clear the selection and show a confirmation message.

2. Saved replies
  a. Add a Saved replies section to Settings with a few starter replies (a greeting, asking for more details, closing a resolved ticket). Staff can add, edit and delete them for the session.
  b. Add an "Insert saved reply" picker next to the ticket reply box. It fills in the reply and replaces {first_name} with the customer's first name.

3. Dark mode / light mode theme toggle in the top bar, beside the user profile icon

4. "My work" for the signed-in user (Alex Morgan)
  a. Add an "Assigned to me" panel to the dashboard showing Alex's open and pending tickets, highest priority first.
  b. Add an assignee filter to the Tickets page, with a "Me" shortcut option, that combines with the existing filters.

Everything stays client-side and session-only like the rest of the demo, with no backend or external services. Each step should come with tests for what it adds.
```

### What to check

- 3–4 Lines with 2–3 Stations each. All ordinary Lines, no Junction, because nothing here asks for the work to be kept separate.

## Goal B: an isolated feature assembled from four parts

```text
Next, I want a Customer profile view: one page per customer, so staff get the full picture before they reply.

This is a bigger feature and I want it built in isolation: nothing should land in the live app piece by piece. Build the parts separately, assemble them into one feature, and let me review and sign off on the complete profile before it's connected to the app.

The profile is made of four parts. Each one is a standalone component that takes a customer and the current ticket list as input, so they can be built independently of one another from today's code:

1. Profile header: avatar, name, company, email, plan badge, "customer since" date, and total / open / resolved ticket counts.
2. Ticket history: every ticket for the customer, newest first, with status and priority badges, each linking to the ticket.
3. Customer notes: staff can add and delete short notes about the customer, with author and time. Session-only, like the rest of the demo.
4. Account health: a simple derived signal (Healthy / Needs attention / At risk) based on how many open, high and urgent tickets the customer has, listing the reasons behind it.

Once I've approved the assembled feature, connect it to the app:
  a. Give it its own route at #/customers/<id> that renders the four parts together, link to it from customer names in the Customers directory and from the Customer panel on the ticket detail page, and keep the existing "View customer's tickets" links working.
  b. Then add a "New ticket for this customer" button on the profile that opens the existing New ticket dialog with that customer preselected.

Everything stays client-side, using the existing sample data, with no backend or external services. Include tests with each part.
```

### What to check

- `junctions` contains one entry with **4 incoming Lines** (header, history, notes, health), each with 1 Station.
- The outgoing Line has **2 Stations** (route and links, then the preselected New ticket button). It must have at least 1.
- The feature brief's acceptance criteria describe the assembled profile.
- No top-level Lines, or only ones unrelated to this feature.
- After launch, the 4 incoming Trains run concurrently and converge into the Junction. Release is a human action, and the outgoing Train runs its Stations and then integrates into Terminus.

### If it misses

- **The planner makes ordinary Lines instead of a Junction:** make the isolation request more explicit without naming the mechanism. Add "Treat this as a feature branch-style effort: the four parts should come together and pass review as one combined feature before anything reaches the main app."
- **Parts merged into fewer than 4 incoming Lines:** add "Each part has a different owner, so build all four separately."
- **The outgoing Line has no Stations** (wiring folded into an incoming part): repeat "Wiring it into routes and links must only happen after I approve the assembled feature."
