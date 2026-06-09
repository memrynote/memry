# Inline "New project" in task project dropdowns

Date: 2026-06-09
Branch: `task-project-quick-create`

## Problem

Project creation is fully implemented (schema, IPC `tasks:project-create`, RPC
`createProject`, the `ProjectModal` create dialog, and the `addProject` context
mutation). But the only create affordance lives in the **Projects tab**
(`project-selector.tsx`: empty-state button + a small `+` icon). When a user is
creating or editing a task and opens the project dropdown, there is **no way to
make a new project** — so the feature is effectively undiscoverable from the
most natural entry point. A nightly tester reported being unable to find how to
create a project.

## Goal

Add a "**+ New project**" entry at the bottom of the project dropdown in the two
task-page surfaces that pick a project for a task. Selecting it opens the
existing create dialog; on save, the new project is created and **auto-selected**
in the dropdown that triggered it.

### Target surfaces (decided)

- **Add Task modal** → `ProjectSelect` (`components/tasks/project-select.tsx`)
- **Task Detail drawer** → `InteractiveProjectBadge`
  (`components/tasks/interactive-project-badge.tsx`), used at
  `task-detail-drawer.tsx:346`

The Projects-tab `ProjectSelector` already has create affordances — leave it
unchanged.

### Non-goals

- No new "quick create" dialog — reuse the existing `ProjectModal`.
- No change to inline task-row project badges (`task-row.tsx`,
  `today-task-row.tsx`), which also render `InteractiveProjectBadge`. The new
  affordance is opt-in there (see below) and stays off for rows.
- No backend/IPC/schema changes — creation path already exists.

## Approach (chosen: A)

A small shared hook owns the existing `ProjectModal` and the create+select flow;
a `Picker.Footer` action is dropped into both dropdowns. Rejected alternatives:
**B** (callback prop mirroring `ProjectSelector`) duplicates modal + create +
select wiring across two parents; **C** (unify into one `<ProjectPicker>`) is an
over-scoped refactor of three call sites.

### Why this is safe

- `TasksProvider` wraps the whole app (`App.tsx:468`); every target render path
  has `addProject` available. The hook still uses `useTasksOptional()` and
  no-ops the create action if context is absent.
- `ProjectModal` in create mode builds a complete `Project`
  (`generateId('project')` + default statuses) and returns it via
  `onSave(project)`, so the new project's `id` is known immediately for
  auto-select.
- `addProject` is optimistic (`setProjects((prev) => [...prev, project])`), so
  the new project is in `projects` before `onCreated` selects it.

## Components

### 1. `useProjectQuickCreate(onCreated)` — new hook

File: `components/tasks/use-project-quick-create.tsx`

```
useProjectQuickCreate(onCreated: (projectId: string) => void)
  -> { canCreate: boolean; openCreate: () => void; dialog: React.ReactNode }
```

- Pulls `addProject` from `useTasksOptional()`. `canCreate = !!ctx`.
- Owns `isOpen` state; `openCreate()` sets it true.
- `dialog` renders `<ProjectModal isOpen onClose onSave>` in create mode
  (no `project` prop). `onSave(project)` → `await addProject(project)` →
  `onCreated(project.id)`.
- Returns `dialog = null` when `!canCreate`.

### 2. Picker footer create action — small component

A `Picker`-aware button rendered inside `Picker.Footer`:

- Uses `usePickerContext().onOpenChange(false)` to close the popover, then calls
  `openCreate()`.
- `Plus` icon + localized label (reuse `createProject`, or add `newProject`).
- Lives in `use-project-quick-create.tsx` (or a tiny sibling) to keep the two
  call sites identical.

### 3. `project-select.tsx` (Add Task modal)

- Call `useProjectQuickCreate(onChange)`.
- Inside `Picker.Content`, after `Picker.List`, render the footer action when
  `canCreate`.
- Render `{dialog}` as a sibling of `<Picker>`.

### 4. `interactive-project-badge.tsx` (drawer)

- Add opt-in prop `allowCreate?: boolean` (default `false`).
- When `allowCreate`, call the hook with `onProjectChange`, render the footer
  action + `{dialog}`. Otherwise unchanged.
- Enable `allowCreate` **only** at `task-detail-drawer.tsx:346`. Task-row and
  today-task-row usages keep current behavior.

## Data flow

```
user opens project dropdown
  -> clicks "+ New project" (footer)
     -> picker closes, ProjectModal opens (create mode)
        -> user fills + Create
           -> ProjectModal.onSave(project)  [full Project w/ id + statuses]
              -> addProject(project)         [optimistic: projects updated]
              -> onCreated(project.id)        [onChange / onProjectChange]
                 -> dropdown shows new project selected
           -> ProjectModal.onClose()          [modal closes; add-task/drawer stays open]
```

Stacked dialogs: `ProjectModal` (Radix `Dialog`) opens over the Add Task modal
(also a `Dialog`) or the Task Detail drawer. Radix supports stacked
dialogs/focus traps; verify in QA.

## Error handling

- `ProjectModal` already validates (name, ≥2 statuses, ≥1 todo + ≥1 done) and
  disables Create until valid.
- If `addProject` rejects, the existing optimistic mutation hook logs the error
  via `createLogger`; the optimistic insert + selection still reflect locally
  (matches current `ProjectSelector` behavior). No new error UI in scope.

## i18n

- Reuse the existing, already-translated key
  `phaseF.componentsTasksProjectsProjectSelector.createProject` ("Create
  Project") for the footer label — no new keys, no locale churn across 31
  files. Run `pnpm --filter @memry/desktop i18n:check` to confirm.

## Testing (TDD)

Renderer (Vitest) — write tests first:

- `project-select`: footer "New project" renders; clicking opens `ProjectModal`;
  saving calls `addProject` once and `onChange` with the new project id.
- `interactive-project-badge`: footer hidden by default; shown when
  `allowCreate`; save flow calls `addProject` + `onProjectChange(newId)`.
- Hook no-op: with no Tasks context, `canCreate` is false / `dialog` is null.

Verify:

```
pnpm --filter @memry/desktop test:renderer
pnpm --filter @memry/desktop typecheck:web
pnpm --filter @memry/desktop i18n:check
pnpm lint
```

Manual QA in `pnpm dev`: create a project from the Add Task modal and from the
Task Detail drawer; confirm auto-select and that inline task-row badges are
unaffected.

## Out of scope / future

- Inline task-row badges could opt in later via the same `allowCreate` prop.
- Keyboard shortcut to create a project from the picker.
