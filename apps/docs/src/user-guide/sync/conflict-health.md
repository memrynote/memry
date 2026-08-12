# Conflict & Health

How memrynote handles conflicting edits across devices, and where to see sync health.

<!-- screenshot: sync status popover showing the conflict count and Dismiss -->

## Conflict Resolution

| Domain                           | Strategy                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Notes & journal entries          | **CRDT (Yjs)** — concurrent edits merge automatically                                                                           |
| Tasks & projects                 | **Field-level vector clocks** — non-overlapping edits merge cleanly; same-field collisions resolve last-writer-wins by tick-sum |
| Inbox items, templates, settings | **Doc-level vector clocks** — last writer wins on conflict                                                                      |

### CRDT Merging (Notes / Journals)

Yjs is **commutative** — two devices typing different paragraphs in the same note merge without losing either side. Even concurrent edits to the same paragraph merge into a sensible result.

You don't see conflict UI for notes because there's nothing to resolve.

### Field-Level Merge (Tasks / Projects)

Each field on a task or project carries its own vector clock. Examples:

- Device A changes **due date**; Device B changes **priority**. Both apply.
- Both devices change **status**. The higher tick-sum wins; ties favor the remote write deterministically.

This is much friendlier than naive last-writer-wins on the whole record.

### Doc-Level Conflicts

For inbox items, templates, tags, folders, bookmarks, saved filters, reminders, and note / journal **metadata** (title, emoji, path, tags — not the text), a same-record concurrent change resolves with a single doc-level vector clock. When both devices changed the record without having seen each other's change, the incoming remote record is written over the local one, the two clocks are merged, and the merged record is queued straight back for push so the other device converges on the same result.

That all happens inside the pull. Nothing stops to ask you.

## What You Actually See

A conflict is **already resolved** by the time the app mentions it. There is no prompt, no marker on the affected note or task, and no compare view — when the count appears, the winning version has been written to your local database and queued back for push.

The whole conflict surface is:

- A yellow **"N conflicts detected"** line in the sync status popover, with a **Dismiss** button
- Nothing on the item itself
- Nothing in [Sync History](#sync-history) — it records pushes, pulls, and errors, not conflicts

### Conflict Count in the Sync Menu

The sync status menu shows how many items hit a conflict, with a **Dismiss** button to clear the notice once you have seen it.

The count tracks _items_, not events — an item that keeps conflicting is counted once, not once per sync round. The notice clears when you dismiss it, when you sign out, or automatically after 24 hours.

## What "Resolved" Means for Your Data

Auto-resolved is not the same as auto-merged. CRDT text keeps both sides. Everywhere else, resolving means picking a winner, and the losing version is overwritten in place.

| Your item                                                                                     | How it resolves                                                                                                                                     | What you can lose                                                                    |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Note & journal **text**                                                                       | Yjs merges both sides                                                                                                                               | Nothing — both edits survive                                                         |
| Tasks & projects                                                                              | Per field, the higher clock tick-sum wins. On an exact tie with differing values the **remote** value wins, unless your local edit was made offline | The losing value on a tied field — you set priority High here, and it comes back Low |
| Note / journal metadata, inbox items, templates, tags, folders, bookmarks, filters, reminders | The **remote** record overwrites the local one and the clocks merge                                                                                 | Your local change to those fields                                                    |
| Canvases                                                                                      | Neither side is dropped — the other version lands as a [conflict copy](/user-guide/canvas/sync-and-limits#conflict-copies)                          | Nothing; you end up with a second canvas                                             |

So the popover count is a **notice, not a task list**. Dismissing it changes nothing about your data — the resolution already happened, and dismissing only retires the warning.

## Sync History

A record of recent sync runs, stored in the local database:

- Pushes (item count, duration)
- Pulls (item count, duration)
- Errors (with the failure message)

It does **not** record conflicts, auth events, or links to affected items.

There is currently no panel for it in the app. Read it from the [CLI](/user-guide/cli#sync-diagnostics):

```bash
memrynote sync history --limit 20
```

The log is cleared when you sign out of sync; it is not aged out on a timer.

## Health View

The [Inbox → Health](/user-guide/inbox/health) tab shows:

- Failed sync jobs with retry buttons
- Items with broken source URLs
- Items missing required fields
- Low-storage warnings (if approaching the vault quota)

This is the actionable punch list — fix everything here and sync should be clean.

## Common Sync Errors

| Error                            | Likely cause                                                                                             | Fix                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| "Authentication expired"         | Refresh token expired                                                                                    | Sign in again                                                                                                   |
| "Quota exceeded"                 | Vault size hit storage limit                                                                             | Upgrade plan or clean attachments                                                                               |
| "A note is too large to sync"    | One note's encrypted sync payload is over the per-request limit — a payload problem, not account storage | Split the note into smaller notes, or move large pasted content into attachments; other notes keep syncing      |
| "Network unreachable"            | Offline                                                                                                  | Reconnect; sync auto-resumes                                                                                    |
| "Server temporarily unavailable" | Cloudflare hiccup                                                                                        | Wait; backoff retries automatically                                                                             |
| "Blob hash mismatch"             | Corruption (rare)                                                                                        | Push the affected item again from the source device                                                             |
| "Crypto version mismatch"        | Sync server behind a desktop release                                                                     | Wait for server to update or downgrade desktop                                                                  |
| "All items failed to decrypt"    | This device's vault key no longer matches the account                                                    | The app signs you out and prompts recovery — sign in and enter your recovery phrase; your server data is intact |

## Recovering an Overwritten Edit

There is no undo for an auto-resolved conflict, and no conflict log to read back. What you can do:

- **Note and journal text** — [Version history](/user-guide/notes/version-history) keeps snapshots, so you can open the timeline and restore. Versions are local to each device, so look on the device you typed the lost text on.
- **Everything else** — set the value again on the device you want to win. That edit carries a higher clock, so it sticks on the next push.

A side-by-side compare with **Keep mine** / **Keep remote** does not exist in memrynote. If you want one, that is a feature request, not a setting you have missed.

## What memrynote Won't Do

memrynote doesn't auto-merge **across record types** — e.g. it won't combine two competing project structures. The vector clock comparison stays within a single record.

It also won't ask you to pick a winner. Every strategy above is built to resolve without a prompt, which is why there is no manual-resolution screen.

And it doesn't store a conflict log. Once a conflict resolves, the losing version is gone from the database, and Sync History never held conflicts to begin with.

## See Also

- [How Sync Works](/user-guide/sync/how-sync-works)
- [Sync Protocol](/architecture/sync-protocol) — architecture deep-dive
- [CRDT & Notes Sync](/architecture/crdt) — for the Yjs internals
