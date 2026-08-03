# Calendar event → project assignment

Date: 2026-08-03
Status: Design approved, not implemented

## Problem

A user creating or editing a calendar event has no discoverable way to assign it to a
project. Some events display a project label, which reads as a feature that is missing
its controls: the label cannot be changed and cannot be removed.

## Current state

The label is real, and so is the missing control surface.

- `calendar_events` has no `project_id` column. The association lives in the generic link
  layer: `project_links (project_id, item_type, item_id)` —
  [packages/db-schema/src/schema/project-links.ts](../../../packages/db-schema/src/schema/project-links.ts).
  The relation is many-to-many.
- The IPC surface already exists and already accepts `calendar_event`:
  `linkProjectItem`, `unlinkProjectItem`, `listForItem` —
  `ProjectLinkItemSchema` / `ProjectListForItemSchema` in
  [packages/contracts/src/tasks-api.ts](../../../packages/contracts/src/tasks-api.ts),
  handlers at
  [apps/desktop/src/main/ipc/tasks-handlers.ts](../../../apps/desktop/src/main/ipc/tasks-handlers.ts).
- The only way to create a link is a right-click on a calendar chip → "Add to project",
  which opens `AddEventToProjectDialog`
  ([add-event-to-project-dialog.tsx](../../../apps/desktop/src/renderer/src/components/tasks/projects/add-event-to-project-dialog.tsx)).
  It is undiscoverable, and it only adds.
- The event form renders `ItemProjectChips` — read-only pills, edit mode only —
  at [calendar-event-form.tsx:222](../../../apps/desktop/src/renderer/src/components/calendar/calendar-event-form.tsx).
  This is the label the user sees.
- `unlinkProjectItem` is exposed in `generated-rpc.ts` but is called from **nowhere** in
  the renderer. There is no removal UI anywhere in the app.
- Neither create path (the quick-create popover from a grid drag, nor the full create
  popover) offers a project field. A link needs an `eventId`, which does not exist until
  the event is saved.

So the work is a missing UI, not a missing data model.

## Decisions

1. **Single project per event in the UI.** A single-select dropdown, matching the
   `project_id` mental model users already have from tasks. The DB stays many-to-many.
2. **Field appears in both create and edit** of the full event form. The quick-create
   popover (grid drag → title-only box) stays minimal and is not touched.
3. **Legacy multi-links are preserved, never silently deleted.** If an event is already
   linked to more than one project (possible today via the right-click flow), the extra
   links render as removable chips beside the picker. Nothing disappears without the user
   removing it.
4. **Edit-mode changes are written immediately** (not deferred to Save). This matches the
   existing right-click flow, and keeps `calendar.tsx` almost untouched. The field is
   styled as a chip/picker row rather than a form input, so it reads as
   applies-immediately. Accepted trade-off: Cancel does not revert a project change.

## Design

### New component: `event-project-field.tsx`

Location: `apps/desktop/src/renderer/src/components/calendar/event-project-field.tsx`

Props:

```ts
interface EventProjectFieldProps {
  mode: 'create' | 'edit'
  /** Saved event id. Required in edit mode; null while drafting. */
  eventId?: string | null
  /** Create mode only: the draft's selected project. */
  value: string | null
  /** Create mode only: writes the selection back into the draft. */
  onChange: (projectId: string | null) => void
  disabled?: boolean
}
```

Project list source: `useTasksOptional()?.projects ?? []`, filtered to `!isArchived`.
`TasksProvider` wraps the whole app
([App.tsx:484](../../../apps/desktop/src/renderer/src/App.tsx)), and
`calendar-task-popover.tsx` already reads projects this way — same pattern, no new fetch
layer.

Picker: the existing `ProjectPicker`
([project-picker.tsx](../../../apps/desktop/src/renderer/src/components/tasks/project-picker.tsx))
with `searchable`, `triggerVariant="button"`, and `includeAllOption` whose label is
"No project" — selecting it emits `null`, which is the clear action.

Behavior by mode:

- **create** — fully controlled. The selection lives in the draft; no IPC is issued. There
  is no event row to link to yet.
- **edit** — self-contained. On mount (and on `eventId` change) it calls
  `tasksService.listForItem('calendar_event', eventId)`. The first link is the picker's
  value; any further links render as chips with an `×`.
  - Picking a project: `unlinkProjectItem(previousPrimary)` if one existed, then
    `linkProjectItem(next)`. Picking "No project" only unlinks.
  - Removing an extra chip: `unlinkProjectItem` for that project.
  - After any write, reload via `listForItem`. Subscribe to `onProjectUpdated` to stay
    fresh when the project changes elsewhere (same as `ItemProjectChips` does today).
  - Failures surface through `extractErrorMessage` + a `sonner` toast, matching
    `AddEventToProjectDialog`.

### Changed: `calendar-event-form.tsx`

Replace the `ItemProjectChips` line at
[calendar-event-form.tsx:222](../../../apps/desktop/src/renderer/src/components/calendar/calendar-event-form.tsx)
with `EventProjectField`, and drop the `mode === 'edit' && eventId` guard so the field
shows in both modes. Position is unchanged: directly under the title input.

`ItemProjectChips` itself is **not** modified — `note.tsx` and `file.tsx` also use it, and
making it editable is out of scope.

### Changed: `types.ts` (draft)

`CalendarEventDraft` gains `projectId: string | null`. Every draft constructor
(`createDraftFromItem`, `createDraftFromAnchor`, the record-based edit draft, and
`CalendarQuickCreateDialog.buildDraft`) initializes it to `null`. In edit mode the field
ignores the draft value and reads from `project_links`; the draft field only carries the
create-mode selection.

### Changed: `calendar.tsx`

In `handlePopoverSave`, create branch only
([calendar.tsx:636](../../../apps/desktop/src/renderer/src/pages/calendar.tsx)):
after a successful `createEvent`, if `draft.projectId` is set, call
`tasksService.linkProjectItem({ projectId, itemType: 'calendar_event', itemId: result.event.id })`.
`createEvent` already returns `{ success, event }` with the new id
(`CalendarEventMutationResponse` in
[packages/contracts/src/calendar-api.ts](../../../packages/contracts/src/calendar-api.ts)),
so no contract change is needed.

A link failure after a successful create must not fail the event creation: log it and show
a toast, keep the event.

### i18n

New keys under `calendar.form` in
[packages/i18n/src/locales/en/calendar.json](../../../packages/i18n/src/locales/en/calendar.json):

- `project` — "Project"
- `no-project` — "No project"
- `remove-from-project` — "Remove from {project}" (chip `×` aria-label)

English gates `i18n:check`; other locales get the same keys.

## Out of scope

- The quick-create popover (grid drag) stays title-only.
- Google external events. They have no `calendar_events` row, so there is no stable
  `item_id` to link. `canAddEventToProject` already restricts to `sourceType === 'event'`.
- The right-click "Add to project" dialog. It keeps working and does not conflict — the
  field reloads through `onProjectUpdated`.
- Making `ItemProjectChips` editable for notes and files.

## Backward compatibility

No schema change, no migration, no contract change. `project_links` already syncs as part
of the project payload
([project-handler.ts](../../../apps/desktop/src/main/sync/item-handlers/project-handler.ts)),
so assignments propagate across devices with no protocol work. Older app versions ignore
the new links gracefully — they are ordinary `project_links` rows, the same shape the
right-click flow has been writing all along.

## Testing

Test-first, per task.

`event-project-field.test.tsx`:

- create mode: selecting a project calls `onChange` and issues **no** IPC
- create mode: "No project" emits `null`
- edit mode: mounts → calls `listForItem` with `('calendar_event', eventId)`
- edit mode: switching project → `unlinkProjectItem(old)` then `linkProjectItem(new)`
- edit mode: "No project" → `unlinkProjectItem` only
- edit mode: event linked to two projects → picker shows the first, second renders as a
  removable chip; `×` calls `unlinkProjectItem` for that project only
- edit mode: a failing link surfaces a toast and leaves prior state intact

`calendar-event-form.test.tsx`: the field renders in both create and edit mode.

`calendar-page.test.tsx` (or a focused test on `handlePopoverSave`): creating with a
project selected calls `linkProjectItem` with the id returned by `createEvent`; creating
with no project selected calls nothing; a link failure keeps the created event.

Verification commands:

```
pnpm --filter @memry/desktop test:renderer
pnpm typecheck
pnpm lint
pnpm --filter @memry/desktop i18n:check
pnpm docs:impact --base <base_commit> --strict
```
