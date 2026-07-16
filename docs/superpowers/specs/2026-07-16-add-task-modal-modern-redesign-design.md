# Add Task modal — modern redesign (from scratch)

**Date:** 2026-07-16
**Status:** Approved, ready for implementation plan
**Surface:** Desktop renderer — the Cmd/Ctrl+Enter "detailed task creation" screen.

## Problem

When quick-adding a task, pressing Cmd/Ctrl+Enter opens a fuller creation screen so
the user can fill in more detail. That screen (`add-task-modal.tsx`) is the app's old,
heavy style: a centered `Dialog` with uppercase field labels, a two-column grid, and
button-style pickers (`ProjectSelect`, `StatusSelect`, `DueDatePicker`, `PrioritySelect`,
`RepeatPicker`). It no longer matches the app's current, calmer UI — the compact,
inline-pill language used by the task rows and the task detail drawer.

Goal: rebuild this screen **from scratch** in the modern style, reusing the exact
primitives the detail drawer already uses. Not a reskin of the old JSX — a fresh build.

## Key insight

The four `Interactive*Badge` components and `TaskRepeatSection` are all driven by
`value + onChange` — none require a `Task` object:

- `InteractivePriorityBadge` — `priority`, `onPriorityChange`, `compact`
- `InteractiveStatusBadge` — `statusId`, `statuses`, `onStatusChange`
- `InteractiveDueDateBadge` — `dueDate`, `dueTime`, `onDateChange`, `onTimeChange`, `isRepeating`
- `InteractiveProjectBadge` — `projectId`, `projects`, `onProjectChange`, `allowCreate`
- `TaskRepeatSection` — `taskTitle`, `repeatConfig`, `isRepeating`, `dueDate`, `projectColor`, `onRepeatChange`

So they plug straight into the modal's local `formData` state. The create screen becomes
visually native to the task page without touching any save/IPC plumbing.

## Decision: surface + save model

Chosen: **centered modal, rebuilt in the modern compact style, keeping explicit create
semantics** (an "Add" button + Cmd/Ctrl+Enter + "Create another"). Rejected alternatives:

- Right-side drawer in create mode — would visually match the edit drawer 1:1 but a
  create flow from quick-add reads more naturally as a focused, centered surface.
- Drawer with live per-field save — would create the task on open, so an empty task
  appears in the list immediately and "Create another" loses meaning.

## Scope

### Rebuilt file: `components/tasks/add-task-modal.tsx`

The JSX/model is rewritten. The **prop contract is unchanged** so no call site changes:

```
AddTaskModalProps { isOpen, onClose, onAddTask, projects, defaultProjectId, defaultDueDate, prefillTitle }
```

Keep the existing two-part structure: outer `AddTaskModal` (Dialog wrapper) + inner
`AddTaskModalSession` remounted per open via `key={formKey}`.

### Shell

`DialogContent` with `className="max-w-lg p-0 gap-0 max-h-[85vh]"`, `bg-surface`. Full-bleed
section dividers matching the detail drawer. Radix's built-in `✕` close button (rendered by
`DialogContent`) is kept. Compact typography (`text-[12px]` base), `[font-synthesis:none]`.

### Layout (top → bottom)

| Section                                     | Content                                                                                                     | Primitive                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Header `py-3.5 px-5 border-b border-border` | `DialogTitle` (a11y-required) = `t('task.add')` + built-in `✕`                                              | `dialog.tsx`                                                                                                                           |
| Title                                       | borderless prominent input, `autoFocus`, `text-[14px] font-medium`, placeholder `t('task.namePlaceholder')` | drawer title style                                                                                                                     |
| Property grid `pt-2 pb-4 px-5 border-b`     | 90px label column × 4 rows: **Status · Priority · Due date · Project**                                      | `InteractiveStatusBadge`, `InteractivePriorityBadge` (`compact`), `InteractiveDueDateBadge`, `InteractiveProjectBadge` (`allowCreate`) |
| Tags                                        | full-bleed (brings its own `px-5 border-b` chrome)                                                          | `TagAutocomplete`                                                                                                                      |
| Description `py-4 px-5 border-b`            | `SectionLabel` + editor                                                                                     | `TaskDescriptionEditor`                                                                                                                |
| Repeat                                      | full-bleed (brings its own chrome)                                                                          | `TaskRepeatSection` (`projectColor` from current project)                                                                              |
| Footer `py-3 px-5 border-t`                 | ☐ Create another · Cancel · **Add**                                                                         | `Checkbox`, `Button`                                                                                                                   |

Header + footer are `shrink-0`; the middle body is `flex-1 overflow-y-auto scrollbar-thin`
so a tall form (description + repeat) scrolls without breaking the modal frame.

### Save model — UNCHANGED

Preserve the working create logic exactly:

- `buildInitialFormData(...)` — initial state from `defaultProjectId`/`defaultDueDate`/`prefillTitle`.
- Title-required validation; focus the title input on failure.
- `handleSubmit` — `createDefaultTask(...)` then assemble `finalTask` with
  `description`, `dueTime`, `priority`, `isRepeating`/`repeatConfig`, `tags`; call `onAddTask`.
- "Create another" resets the form (keeps project/status/due) and re-focuses title.
- Cmd/Ctrl+Enter submits.

Rebuilding this data plumbing from scratch would risk regressions for no benefit, so it
stays. "From scratch" applies to the UI/model, which is fully replaced.

### Removed from THIS file (not deleted from repo)

`ProjectSelect`, `StatusSelect`, `DueDatePicker`, `PrioritySelect`, `RepeatPicker`,
`CustomRepeatDialog` (now reached via `TaskRepeatSection`), boxed `Input` for title,
the uppercase-`<label>` pattern, `DialogHeader`. These primitives may be used elsewhere;
they are only removed from this file's imports. If any becomes fully unused repo-wide,
report it — do not delete without confirmation.

## Non-goals / deliberate exclusions

- **No Reminder row** — the drawer's reminder uses `TaskReminderButton taskId=`, but no
  task exists yet at create time. The old modal had no reminder either.
- **No Sub-issues / Related notes** — edit-time concerns; not part of creation.
- Field set stays identical to today: title, status, priority, due date, project, tags,
  description, repeat.
- No change to `pages/tasks.tsx`, `use-undoable-task-actions`, or `tasks-service`.

## Edge cases

- **Project change resets status** — keep `handleProjectChange` deriving the default todo
  status for the newly selected project (as today).
- **Empty states** render sensibly: due badge shows "No date", priority "None", status the
  status name, project the project name.
- **Pickers inside a Dialog** portal to `body` and work at runtime (the old modal already
  nested `Picker`/`Popover` in a Dialog successfully).

## Testing

Known gotcha: Radix Popover/Picker do not open in jsdom, so badge popover interactions
can't be asserted in unit tests. Focus tests on what matters:

- Renders with prefill title and default project/status.
- Title-required validation blocks submit and keeps the modal open.
- `handleSubmit` calls `onAddTask` with a correctly assembled task (priority/tags/repeat/
  description/dueTime propagated).
- "Create another" keeps the modal open and clears the title.

Verification: `pnpm --filter @memry/desktop typecheck:web`, `test:renderer`, `pnpm lint`,
and live `pnpm dev` driving the quick-add → Cmd/Ctrl+Enter → modal flow.

## Docs impact

Renderer-only UI change to an existing surface. Run `pnpm docs:impact --base <base> --strict`
during implementation; update `apps/docs/src/**` only if the gate flags `missing-docs`.
