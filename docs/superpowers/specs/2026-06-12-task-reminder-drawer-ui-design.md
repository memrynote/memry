# Task Reminder Drawer UI — Design

**Date:** 2026-06-12
**Branch:** `task-reminders`
**Status:** Approved, ready for implementation plan

## Problem

The task detail drawer exposes reminders as a bare bell icon (`TaskReminderButton`).
Problems:

1. When a reminder is set, the date is only visible on hover (tooltip). At rest you
   just see a colored bell — no idea _when_ it fires.
2. Clicking always opens the picker in "create new" mode. There is no way to see the
   list of reminders on a task, even when there is more than one.
3. Reminders are effectively read-only once created — no edit, and delete is not
   surfaced in the UI (the hook supports it but nothing calls it).

## Goal

Make the reminder row self-explanatory and manageable, matching the design language of
the `Due date` row directly above it (`InteractiveDueDateBadge`: a value-led bordered
badge that opens a popover).

## Decisions (locked with user)

- **Set-state display:** bordered date badge (matches the Due date badge), not plain text.
- **Click menu when reminders exist:** presets-first layout — keep quick-add presets at
  top, show a `Set (N)` list below with per-row edit + delete.
- **Edit:** pencil on a row opens the custom date/time + note picker prefilled with
  current values; Save calls the existing update API.

## Non-goals

- Extending note/journal reminder buttons to the same management UI (task-only for now).
- Snooze (lives in the inbox reminder detail, not the task drawer).
- Recurring reminders.
- Confirm-on-delete dialog (delete is immediate; a toast already fires).

## Architecture

### 1. Drawer row → date badge — `components/tasks/task-reminder-button.tsx`

Replace the icon-only `Button` trigger with a bordered chip trigger mirroring
`InteractiveDueDateBadge`'s neutral badge style (bell glyph + label):

- **Empty:** `🔔 Set reminder`. Clicking opens the picker on the presets view.
- **Set (1 active):** `🔔 <formatReminderDate(nextReminder.remindAt)>` — always visible.
- **Set (N>1 active):** badge label = next reminder date, plus a small `+{N-1}` pill.

Remove the now-redundant absolute corner count pill and the hover tooltip (the date is
visible at rest). Keep an `aria-label` summarizing state for accessibility.

The chip is the `ReminderPicker` trigger. The component wires the task's reminders and
edit/delete handlers into the picker (see §2).

### 2. Extend `ReminderPicker` (opt-in, backward compatible) — `components/reminder/reminder-picker.tsx`

Add optional props:

```ts
reminders?: ReminderListEntry[]        // active reminders to manage
onEdit?: (id: string, date: Date, note?: string) => void
onDelete?: (id: string) => void
```

`ReminderListEntry` is the existing reminder item shape from
`useRemindersForTarget`/`use-task-reminders` (`id`, `remindAt`, `note`, `status`).

Behavior:

- When `reminders?.length`, render a `Set (N)` section **below** the presets/custom
  entry and the note field (presets-first layout). Each row shows: bell glyph + formatted
  date, an optional second line with the note, a `✎` edit button, and a `🗑` delete button.
- `🗑` → `onDelete(id)`.
- `✎` → enter edit mode (see §3).
- Callers that omit these props (note, journal, note page) render exactly as today —
  no `Set (N)` section, no edit/delete. Verified call sites:
  `note-reminder-button.tsx`, `journal-reminder-button.tsx`, `pages/note.tsx`.

### 3. Edit mode — third `PickerMode` (`'edit'`)

Extend the existing `PickerMode = 'presets' | 'custom'` to include `'edit'`, with an
`editingId` state. Tapping `✎`:

1. Sets `editingId`, prefills `selectedDate` / `selectedTime` / `note` from the reminder.
2. Switches to `'edit'` mode, which reuses the custom calendar + time + note UI with a
   header `‹ Edit reminder` (back arrow returns to presets+list, clearing `editingId`).
3. Save → `onEdit(editingId, computedDate, note || undefined)`, then close + reset.

Reuses `useUpdateReminder` / `UpdateReminderSchema` (`remindAt`, `note`) — no backend or
contract changes.

### 4. Hook — `hooks/use-task-reminders.ts`

Add an `editReminder` action wrapping `useUpdateReminder`:

```ts
editReminder: (id: string, remindAt: Date, note?: string) => Promise<boolean>
```

- Calls `updateReminderMutation.mutateAsync({ id, remindAt: remindAt.toISOString(), note })`.
- On success: `toast.success(t('reminders.toast.updated'))`, return `true`.
- On failure: `toast.error(extractErrorMessage(..., t('reminders.toast.updateFailed')))`.

Expose it in the `actions` object alongside `setReminder` and `deleteReminder`.

### 5. i18n — `packages/i18n/src/locales/en/tasks.json`

Add under `reminders`:

- `set` — `Set` (section header for the existing-reminders list; shown as `Set (N)`)
- `edit` — `Edit reminder` (button aria-label)
- `delete` — `Delete reminder` (button aria-label)
- `editTitle` — `Edit reminder` (edit-mode header)
- `toast.updated` — success toast on edit
- `toast.updateFailed` — failure toast on edit

English only; `i18n:check` gates English keys only (other locales are non-fatal warnings).

## Data flow

```
TaskReminderButton
  ├─ useTaskReminders(taskId)
  │     reminders, nextReminder, activeReminderCount, hasActiveReminder
  │     actions: setReminder | editReminder | deleteReminder
  └─ ReminderPicker (trigger = date badge)
        presets / custom  → onSelect           → actions.setReminder
        Set (N) list      → ✎ → edit mode Save → actions.editReminder
                            🗑                   → actions.deleteReminder
```

`useUpdateReminder` / `useDeleteReminder` already invalidate the reminders query and the
`onReminderUpdated` event refreshes the list, so the badge and list re-render after any
mutation.

## Error handling

- All three actions return `boolean` and surface failures via toast + logger
  (`extractErrorMessage`), matching the existing `setReminder`/`deleteReminder` pattern.
- Edit Save is disabled until a date is selected (reuses the custom-mode guard).

## Testing (TDD — tests first)

- `hooks/use-task-reminders.test.tsx`: `editReminder` calls update with ISO date + note,
  toasts on success, toasts + returns false on failure.
- `components/reminder/reminder-picker.test.tsx`: with `reminders` prop, `Set (N)` section
  and rows render; `✎` enters edit mode prefilled; Save calls `onEdit` with id+date+note;
  `🗑` calls `onDelete(id)`; with no `reminders` prop the section is absent (regression
  guard for note/journal callers).
- `components/tasks/task-detail-drawer.test.tsx`: badge shows `Set reminder` when empty
  and the formatted date when set; `+N` pill appears for N>1 active.

Note: `ReminderPicker` uses the `Picker` (Radix Popover) primitive, which does not open on
click in jsdom — follow the existing convention of mocking `@/components/ui/picker` (see
memory `picker-jsdom-mock`).

## Verification

`pnpm --filter @memry/desktop test:renderer`, `pnpm typecheck`, `pnpm lint`,
`pnpm --filter @memry/desktop i18n:check`. Manual: open a task drawer, set/edit/delete
reminders, confirm badge + list reflect changes and `+N` pill is correct.
