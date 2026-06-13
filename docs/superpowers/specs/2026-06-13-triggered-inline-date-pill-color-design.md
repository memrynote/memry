# Triggered inline date pill color (#E56458)

Date: 2026-06-13
Branch: feat/inline-reminder
Status: Approved (design)

## Problem

Inline `@`-date pills with a reminder render blue and keep that color forever.
Once a pill's reminder has fired and is sitting in the inbox, nothing in the note
distinguishes it from a still-pending pill. We want a fired pill to read red
(`#E56458`) so the user can see at a glance, in the note body, that this reminder
already went off.

## Behavior (decided)

- **When it turns red:** as soon as the reminder fires (its row reaches a fired
  state), automatically — no click required. Persists across app reload.
- **What turns red:** the whole pill — date label, `@`, and alarm icon.
- **When it reverts:** never, until the pill itself is edited (its date/remind
  offset changed). Dismissing or snoozing the reminder keeps it red.

## Core signal

A note_date reminder row's `triggeredAt` column is the single source of truth.

- `reminders.triggeredAt` (TEXT, nullable) is stamped when the scheduler fires
  the reminder.
- `RemindersService.dismiss` sets `status='dismissed'` + `dismissedAt` but does
  **not** clear `triggeredAt` → red survives dismiss.
- `RemindersService.update({ remindAt })` resets `status='pending'`,
  `triggeredAt=null`, `snoozedUntil=null` — but only when `remindAt` actually
  changes.
- `syncNoteDateReminders` (note-date-reminders.ts) reconciles pills→rows keyed by
  `anchorId`. It calls `update` only when `row.remindAt !== want.remindAt`, so:
  - editing a pill's date/time or remind offset → `remindAt` changes →
    `triggeredAt` cleared → red clears (re-armed reminder).
  - cosmetic edits (dateFormat/timeFormat only) → `remindAt` unchanged → row
    preserved → stays red.
  - removing the reminder (offset → `none`) → row deleted → not red.

Therefore the red condition is exactly: **a `note_date` reminder for the pill's
`anchorId` has `triggeredAt != null`.** No new columns, no markdown/CRDT changes.
This is a per-device presentational overlay only; fired state is never written
into the pill props or the note markdown.

## Architecture

Three small pieces, all renderer-side.

### 1. Read path — fired anchor ids

In `ContentArea` (already holds `noteId` and `editorContainerRef`):

```ts
const { reminders } = useRemindersForTarget('note_date', noteId ?? '')
const firedAnchorIds = useMemo(
  () =>
    new Set(
      reminders
        .filter((r) => r.triggeredAt)
        .map((r) => r.anchorId)
        .filter(Boolean)
    ),
  [reminders]
)
```

`useRemindersForTarget` already invalidates its query on reminder
created/deleted/dismissed events. It does **not** currently react to a reminder
_firing_. To recolor live when a pill fires while the note is open, the new hook
(below) also subscribes to `window.api.onReminderDue` and invalidates the
`note_date`/`noteId` query (or refetches) on a matching event.

### 2. Apply mechanism — overlay hook (effect + MutationObserver)

New hook `useTriggeredDatePills(editorContainerRef, firedAnchorIds)`:

- An effect walks `container.querySelectorAll('.date-mention[data-anchor-id]')`
  and sets `data-fired="true"` when the anchor id is in `firedAnchorIds`, removes
  the attribute otherwise. Re-runs when `firedAnchorIds` changes.
- A `MutationObserver` on the container subtree (`childList`, `subtree`)
  re-applies the same pass when BlockNote recreates pill DOM (pills are raw DOM
  node-views recreated on `updateBlock`). Debounced via microtask/rAF to coalesce
  bursts.

This mirrors the existing `data-anchor-id` query already in `ContentArea`
(handleDateMentionChange) and the sibling delegated hooks on
`editorContainerRef` (wikiLinkHover, linkMentionHover).

Rejected alternatives:

- Re-apply on editor `onChange` only — misses DOM recreation paths that don't
  fire onChange; red can briefly drop.
- Bake `data-fired` into pill props via `updateBlock` — would serialize
  per-device fired state into the CRDT/markdown. Not allowed.

### 3. CSS

Add after the existing date-mention color rules in
`apps/desktop/src/renderer/src/assets/base.css`:

```css
.bn-shadcn .bn-editor .date-mention[data-fired='true'],
.dark .bn-editor .date-mention[data-fired='true'],
.date-mention[data-fired='true'] {
  --date-mention-color: #e56458;
}
```

The pill already derives label, `@`, alarm icon, and hover tint from
`--date-mention-color`, so overriding the one variable turns the whole pill red.
Selector specificity matches the existing blue rules and the rule is placed after
them (incl. the `.dark` variant), so it wins via source order. One color for both
themes — no light/dark split needed.

## Edge cases

- Date-only pills (`remind='none'`) never get a reminder row → never red.
- Deleting the reminder offset deletes the row → `data-fired` removed on next
  pass → red clears.
- Reminder fires while note is open → `onReminderDue` invalidates query →
  `firedAnchorIds` updates → effect repaints. → red appears without reload.
- Pill DOM recreated by an unrelated edit → observer re-applies `data-fired`.

## Testing

- Unit: `firedAnchorIds` derivation (triggeredAt filter) and the overlay hook in
  jsdom — assert `data-fired` toggles on/off as the fired set changes and after a
  simulated mutation (node removed + re-added).
- E2E: extend `apps/desktop/tests/e2e/inline-date-ghost.e2e.ts` — create a
  reminder pill, simulate the reminder firing, assert the pill carries
  `data-fired="true"` and its computed color resolves to `#e56458`.

## Files touched

- `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`
  — wire `useRemindersForTarget` + new hook.
- new `apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.ts`
  (+ test).
- `apps/desktop/src/renderer/src/assets/base.css` — `data-fired` rule.
- `apps/desktop/tests/e2e/inline-date-ghost.e2e.ts` — assertion.

## Out of scope

- Changing the inbox item's own appearance (this is about the in-note pill).
- Any new DB column or sync/CRDT change.
- Recoloring non-reminder (date-only) pills.
