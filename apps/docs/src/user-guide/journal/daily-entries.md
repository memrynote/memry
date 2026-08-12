# Daily Entries

A dated note per day. memrynote creates one on demand and remembers where you left off.

<!-- screenshot: journal day view with full-width writing -->

## Opening Today

Open Journal from the sidebar, or use <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>E</kbd> if you've remapped it that way. By default memrynote opens **today's** entry.

If today's entry doesn't exist yet, it's created on first focus, seeded by your [default journal template](/user-guide/journal/templates-settings).

## Writing

The same BlockNote editor is used for journal entries — slash commands, markdown shortcuts, wiki links, attachments, AI inline. Anything you can do in a note works here too.

Journal entries also share note review tools: selection comments and the aligned right review rail. See [Comments](/user-guide/notes/editing#comments).

Use **Add property** or **Add tag** above the date heading to organize a daily entry before writing.

## Width

Journal pages follow the global **Width** setting in [Settings → Editor](/user-guide/settings#editor). To override it just for the Journal, use the **Full width** toggle in the journal ⋮ menu — it widens the writing column edge to edge and applies to every journal page until you turn it off.

## Stats Footer

If enabled, the editor footer shows:

- Word count
- Character count
- Entries this week / month

Toggle from [Settings → Journal](/user-guide/settings#journal).

## Navigating Days

| How                                | Action                                             |
| ---------------------------------- | -------------------------------------------------- |
| Header arrows                      | Previous / next day                                |
| Left / right arrow keys            | Previous / next day when the editor is not focused |
| Date breadcrumb                    | Click for the date picker                          |
| [Day Panel](/user-guide/day-panel) | Calendar grid; click any date                      |
| Calendar nav                       | Day / month / year views                           |

When the journal editor is focused, arrow keys stay inside the editor. Press <kbd>Esc</kbd> to leave the editor, then use the left / right arrow keys to move between days.

See [Calendar Navigation](/user-guide/journal/calendar-navigation) for the larger views.

## Wiki Linking from Today

You can wiki-link to other journal entries: `[[2026-05-07]]` resolves to that day's entry. Backlinks work the same as for notes.

## What If I Skip a Day?

Nothing. memrynote doesn't pad missing days with empty entries. Calendar heatmaps show genuine activity, not noise.

## Sync

Journal entries sync as Yjs CRDTs (same as notes). Two devices writing on the same date during a flight merge cleanly when they reconnect.

If two devices create same-date entries with **different IDs** (rare, but possible during long offline stretches), memrynote keeps both and renames one to disambiguate. See [CRDT & Notes Sync](/architecture/crdt) for the underlying behavior.
