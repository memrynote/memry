# Conflict & Health

How Memry handles conflicting edits and where to see sync health.

<!-- screenshot: sync history panel showing recent activity -->

## Conflict Resolution

- **Notes and journal entries** merge automatically via CRDT (Yjs).
- **Tasks and projects** use field-level vector clocks; non-overlapping field edits merge cleanly. Concurrent edits to the same field resolve by last-writer-wins after tick comparison.

## Conflict Indicators

If a conflict can't be resolved automatically (rare), Memry surfaces a banner on the affected item and asks you to choose a side.

## Sync History

A panel that lists recent sync events with timestamps and outcomes.

## Health View

[Inbox → Health](/user-guide/inbox) shows failed sync jobs and items that need user input.

## Common Causes of Sync Errors

- Offline / flaky network
- Auth expired (sign back in)
- Quota exceeded (see [Settings → Vault](/user-guide/settings#vault))
- Server temporarily unavailable
