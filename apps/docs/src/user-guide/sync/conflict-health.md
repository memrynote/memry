# Conflict & Health

How memrynote handles conflicting edits across devices, and where to see sync health.

<!-- screenshot: sync history panel showing recent activity -->

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

For inbox items, templates, and other lower-frequency types, a same-record concurrent change resolves with a single doc-level vector clock. memrynote surfaces a banner if a true unresolvable case occurs (rare).

## Conflict Indicators

When a conflict requires your attention (very rare given the strategies above), memrynote:

- Shows a yellow banner on the affected item
- Adds an entry to **Sync History**
- Lets you choose to keep your version, the remote version, or merge manually

### Conflict Count in the Sync Menu

The sync status menu shows how many items hit a conflict, with a **Dismiss** button to clear the notice once you have seen it.

The count tracks _items_, not events — an item that keeps conflicting is counted once, not once per sync round. The notice clears when you dismiss it, when you sign out, or automatically after 24 hours.

## Sync History

A panel that lists recent sync events:

- Pushes (succeeded / failed)
- Pulls (counts of new items)
- Conflicts (with links to the items)
- Auth events (sign-in, key rotation, device link)

Open from the sync status indicator menu.

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

## Resolving a Conflict Manually

If the rare manual-conflict banner appears on a non-CRDT item:

1. Click the banner
2. Compare the two versions side-by-side
3. Pick **Keep mine**, **Keep remote**, or copy text between them and save
4. The conflict marker clears

For CRDT items (notes / journals), there's no manual conflict step — the merge always succeeds.

## What memrynote Won't Do

memrynote doesn't auto-merge **across record types** — e.g. it won't combine two competing project structures. The vector clock comparison stays within a single record.

It also doesn't store a permanent "conflict log" — once resolved, the conflict is gone. Sync History keeps the metadata for a few weeks for debugging.

## See Also

- [How Sync Works](/user-guide/sync/how-sync-works)
- [Sync Protocol](/architecture/sync-protocol) — architecture deep-dive
- [CRDT & Notes Sync](/architecture/crdt) — for the Yjs internals
