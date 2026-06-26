# Inbox Conversion Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an inbox item convert into a calendar event or a reminder (note + reminder), give `convertToTask` real options, and fix conversion provenance — all by reusing existing create paths. No new entity, no sync wiring, no calendar build.

**Architecture:** New `convertToEvent` / `convertToReminder` live beside the existing `convertToNote` / `convertToTask` in `apps/desktop/src/main/inbox/filing.ts`. They call existing create APIs (`upsertCalendarEvent`, `remindersService.n`, `createNote`, `insertTask`) and reuse `markItemAsFiled` + `recordFilingHistory` + window emit. `FilingAction` gains `task | event | reminder` so filed items carry real provenance. IPC + preload expose the new functions; the inbox detail panel gains Event/Reminder buttons + minimal forms with binary gating.

**Tech Stack:** Electron main (better-sqlite3 + Drizzle), React 19 renderer, Vitest, IPC contracts (Zod) in `packages/contracts` + `packages/rpc` + `packages/domain-inbox`.

## Global Constraints

- Prettier: single quotes, no semicolons, 100 char width, no trailing commas.
- Logging: `createLogger('Scope')`; never raw `console.*`.
- User-facing errors: `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- IPC boundary: all renderer↔main goes through `packages/contracts`; run `pnpm ipc:generate` then `pnpm ipc:check` after editing contract types / preload / handlers.
- Tailwind logical props only in new renderer code (`ms-*`/`me-*`/`ps-*`/`pe-*`/`start-*`/`end-*`/`text-start`/`text-end`); the renderer pre-commit guard scans the whole staged file.
- Native module gotcha: if a Node/vitest run throws `ERR_DLOPEN_FAILED`, run `pnpm --filter @memry/desktop rebuild:node` before retrying.
- Run desktop main tests with: `pnpm --filter @memry/desktop test:main`. Run a single renderer test with `vitest run --config config/vitest.config.ts --project renderer <file>`.
- Binary inbox types = `image | pdf | video | clip` (`isBinaryType` in filing.ts). `voice` is NOT binary for conversion: use `item.transcription` as its text.

---

### Task 1: Extend `FilingAction` + fix `convertToTask` provenance

**Files:**

- Modify: `packages/contracts/src/inbox-api.ts:32`
- Modify: `packages/rpc/src/inbox.ts:22`
- Modify: `packages/domain-inbox/src/types.ts:13`
- Modify: `apps/desktop/src/main/inbox/filing.ts` (`markItemAsFiled`, `recordFilingHistory`, `convertToTask`)
- Test: `apps/desktop/src/main/inbox/filing.test.ts`

**Interfaces:**

- Produces: `FilingAction = 'folder' | 'note' | 'linked' | 'task' | 'event' | 'reminder'`; `markItemAsFiled(itemId: string, filedTo: string, filedAction: FilingAction): void`; `convertToTask` files as `'task'` with bare `taskId`.

- [x] **Step 1: Write the failing test** — add to the existing `describe('convertToTask', ...)` block in `filing.test.ts`, mirroring that block's existing setup/mocks:

```ts
it('files as task with the bare task id as filedTo', async () => {
  const itemId = await seedInboxItem({ type: 'note', title: 'Ship the report' })
  const res = await convertToTask(itemId)
  expect(res.success).toBe(true)
  const row = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
  expect(row?.filedAction).toBe('task')
  expect(row?.filedTo).toBe(res.taskId)
  expect(row?.filedTo?.startsWith('task:')).toBe(false)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- filing.test.ts -t "bare task id"`
Expected: FAIL — `filedAction` is `'note'` and `filedTo` is `task:<id>`.

- [x] **Step 3: Widen the three type definitions**

In each of the three files replace the union with:

```ts
export type FilingAction = 'folder' | 'note' | 'linked' | 'task' | 'event' | 'reminder'
```

(`InboxFilingAction` in `packages/rpc/src/inbox.ts` and `packages/domain-inbox/src/types.ts`; `FilingAction` in `packages/contracts/src/inbox-api.ts`.)

- [x] **Step 4: Widen the main signatures + fix provenance** in `filing.ts`

Change the `filedAction` param type on `markItemAsFiled` and `recordFilingHistory` from `'folder' | 'note' | 'linked'` to the full union (import `FilingAction` from `@memry/contracts/inbox-api`). In `convertToTask`, replace:

```ts
markItemAsFiled(itemId, `task:${taskId}`, 'note')
recordFilingHistory(item.type, item.content, `task:${taskId}`, 'note', mergedTags)
```

with:

```ts
markItemAsFiled(itemId, taskId, 'task')
recordFilingHistory(item.type, item.content, taskId, 'task', mergedTags)
```

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- filing.test.ts -t "bare task id"`
Expected: PASS. Then run the whole file: `pnpm --filter @memry/desktop test:main -- filing.test.ts` — existing convertToTask assertions that asserted the `task:` prefix must be updated to the bare id in the same commit.

- [x] **Step 6: Typecheck the packages**

Run: `pnpm typecheck`
Expected: PASS (the widened union is a superset; no exhaustiveness breaks expected — fix any that surface).

- [x] **Step 7: Commit**

```bash
git add packages/contracts/src/inbox-api.ts packages/rpc/src/inbox.ts packages/domain-inbox/src/types.ts apps/desktop/src/main/inbox/filing.ts apps/desktop/src/main/inbox/filing.test.ts
git commit -m "feat(inbox): add task/event/reminder FilingAction + fix convertToTask provenance"
```

---

### Task 2: `convertToEvent`

**Files:**

- Modify: `apps/desktop/src/main/inbox/filing.ts`
- Test: `apps/desktop/src/main/inbox/filing.test.ts`

**Interfaces:**

- Consumes: `upsertCalendarEvent(db, NewCalendarEvent)` from `../calendar/repositories/calendar-events-repository`; `syncCalendarEventCreate(id)` from `../calendar/runtime-effects`; `CalendarChannels` from `@memry/contracts/ipc-channels`; existing `getInboxItem`, `getItemTags`, `generateNoteTitle`, `isBinaryType`, `markItemAsFiled`, `recordFilingHistory`, `generateId`.
- Produces: `convertToEvent(itemId: string, input: { startAt: string; endAt?: string | null; isAllDay?: boolean; location?: string | null }): Promise<{ success: boolean; eventId: string | null; error?: string }>`

- [x] **Step 1: Write the failing test** (new `describe('convertToEvent', ...)`, mirror convertToTask setup):

```ts
describe('convertToEvent', () => {
  it('creates a calendar event and files the item as event', async () => {
    const itemId = await seedInboxItem({ type: 'note', title: 'Budget meeting' })
    const res = await convertToEvent(itemId, { startAt: '2099-01-02T15:00:00.000Z' })
    expect(res.success).toBe(true)
    const event = db.select().from(calendarEvents).where(eq(calendarEvents.id, res.eventId!)).get()
    expect(event?.title).toBe('Budget meeting')
    expect(event?.startAt).toBe('2099-01-02T15:00:00.000Z')
    const row = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
    expect(row?.filedAction).toBe('event')
    expect(row?.filedTo).toBe(res.eventId)
  })

  it('rejects binary items', async () => {
    const itemId = await seedInboxItem({ type: 'pdf', title: 'doc.pdf' })
    const res = await convertToEvent(itemId, { startAt: '2099-01-02T15:00:00.000Z' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/binary|file|text/i)
  })

  it('rejects already-filed items', async () => {
    const itemId = await seedInboxItem({
      type: 'note',
      title: 'x',
      filedAt: new Date().toISOString()
    })
    const res = await convertToEvent(itemId, { startAt: '2099-01-02T15:00:00.000Z' })
    expect(res.success).toBe(false)
  })
})
```

Add `import { calendarEvents } from '@memry/db-schema/schema/calendar-events'` to the test if not present.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- filing.test.ts -t convertToEvent`
Expected: FAIL — `convertToEvent is not a function`.

- [x] **Step 3: Implement `convertToEvent`** in `filing.ts` (add imports at top of file):

```ts
import { upsertCalendarEvent } from '../calendar/repositories/calendar-events-repository'
import { syncCalendarEventCreate } from '../calendar/runtime-effects'
import { CalendarChannels } from '@memry/contracts/ipc-channels'

export async function convertToEvent(
  itemId: string,
  input: { startAt: string; endAt?: string | null; isAllDay?: boolean; location?: string | null }
): Promise<{ success: boolean; eventId: string | null; error?: string }> {
  try {
    const db = requireDatabase()
    const item = getInboxItem(db, itemId)
    if (!item) return { success: false, eventId: null, error: 'Inbox item not found' }
    if (item.filedAt) return { success: false, eventId: null, error: 'Item has already been filed' }
    if (isBinaryType(item.type)) {
      return {
        success: false,
        eventId: null,
        error: 'Only text and voice items can become an event'
      }
    }

    const content = item.type === 'voice' ? item.transcription : item.content
    const existingTags = getItemTags(db, itemId)
    const mergedTags = [...new Set([...existingTags, 'inbox'])]

    const id = generateId()
    const now = new Date().toISOString()
    upsertCalendarEvent(db, {
      id,
      title: generateNoteTitle(item),
      description: content ?? null,
      location: input.location ?? null,
      startAt: input.startAt,
      endAt: input.endAt ?? null,
      timezone: 'UTC',
      isAllDay: input.isAllDay ?? false,
      createdAt: now,
      modifiedAt: now
    })

    try {
      syncCalendarEventCreate(id)
    } catch (error) {
      log.warn('syncCalendarEventCreate failed; event persisted locally', error)
    }
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(CalendarChannels.events.CHANGED, { id })
    })

    markItemAsFiled(itemId, id, 'event')
    recordFilingHistory(item.type, item.content, id, 'event', mergedTags)
    log.info(`Converted to event: ${id}`)
    return { success: true, eventId: id }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Error converting to event:', message)
    return { success: false, eventId: null, error: message }
  }
}
```

Verify the `CalendarChannels.events.CHANGED` payload shape against the IPC handler in `apps/desktop/src/main/ipc/calendar-handlers.ts` (line ~88 `emitCalendarChanged`); match its exact shape rather than guessing if it differs.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- filing.test.ts -t convertToEvent`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/desktop/src/main/inbox/filing.ts apps/desktop/src/main/inbox/filing.test.ts
git commit -m "feat(inbox): convertToEvent reuses calendar_events create"
```

---

### Task 3: `convertToReminder`

**Files:**

- Modify: `apps/desktop/src/main/inbox/filing.ts`
- Test: `apps/desktop/src/main/inbox/filing.test.ts`

**Interfaces:**

- Consumes: `createNote(...)` (already imported in filing.ts); the main reminders create used in `reminder-handlers.ts` — confirm the exact import there (`remindersService.n({ targetType, targetId, remindAt, title? })` from `@memry/app-core/reminders` via its `nsService(db)` factory). Reuse `generateNoteTitle`, `generateNoteContent`, `extractItemProperties`, `getItemTags`.
- Produces: `convertToReminder(itemId: string, input: { remindAt: string }): Promise<{ success: boolean; noteId: string | null; error?: string }>`

- [x] **Step 1: Confirm the reminder create import**

Open `apps/desktop/src/main/ipc/reminder-handlers.ts`, find the create call (`remindersService.n(input)`) and its import. Use the SAME factory/import in filing.ts. Do not invent a new helper.

- [x] **Step 2: Write the failing test** (new `describe('convertToReminder', ...)`):

```ts
describe('convertToReminder', () => {
  it('creates a note and a note-target reminder, files as reminder', async () => {
    const itemId = await seedInboxItem({ type: 'note', title: 'Follow up with Sam' })
    const res = await convertToReminder(itemId, { remindAt: '2099-01-02T09:00:00.000Z' })
    expect(res.success).toBe(true)
    expect(res.noteId).toBeTruthy()
    const row = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
    expect(row?.filedAction).toBe('reminder')
  })

  it('rejects a past remindAt', async () => {
    const itemId = await seedInboxItem({ type: 'note', title: 'x' })
    const res = await convertToReminder(itemId, { remindAt: '2000-01-01T00:00:00.000Z' })
    expect(res.success).toBe(false)
  })

  it('rejects binary items', async () => {
    const itemId = await seedInboxItem({ type: 'image', title: 'pic.png' })
    const res = await convertToReminder(itemId, { remindAt: '2099-01-02T09:00:00.000Z' })
    expect(res.success).toBe(false)
  })
})
```

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- filing.test.ts -t convertToReminder`
Expected: FAIL — `convertToReminder is not a function`.

- [x] **Step 4: Implement `convertToReminder`** in `filing.ts` (using the import confirmed in Step 1; example assumes `nsService`):

```ts
export async function convertToReminder(
  itemId: string,
  input: { remindAt: string }
): Promise<{ success: boolean; noteId: string | null; error?: string }> {
  try {
    const db = requireDatabase()
    const item = getInboxItem(db, itemId)
    if (!item) return { success: false, noteId: null, error: 'Inbox item not found' }
    if (item.filedAt) return { success: false, noteId: null, error: 'Item has already been filed' }
    if (isBinaryType(item.type)) {
      return {
        success: false,
        noteId: null,
        error: 'Only text and voice items can become a reminder'
      }
    }
    if (new Date(input.remindAt).getTime() <= Date.now()) {
      return { success: false, noteId: null, error: 'Reminder time must be in the future' }
    }

    const existingTags = getItemTags(db, itemId)
    const mergedTags = [...new Set([...existingTags, 'inbox'])]
    const title = generateNoteTitle(item)
    const note = await createNote({
      title,
      content: generateNoteContent(item),
      tags: mergedTags,
      properties: extractItemProperties(item.metadata)
    })

    nsService(db).n({ targetType: 'note', targetId: note.id, remindAt: input.remindAt, title })

    markItemAsFiled(itemId, note.path, 'reminder')
    recordFilingHistory(item.type, item.content, note.path, 'reminder', mergedTags)
    log.info(`Converted to reminder: note ${note.id}`)
    return { success: true, noteId: note.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Error converting to reminder:', message)
    return { success: false, noteId: null, error: message }
  }
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- filing.test.ts -t convertToReminder`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/desktop/src/main/inbox/filing.ts apps/desktop/src/main/inbox/filing.test.ts
git commit -m "feat(inbox): convertToReminder creates note + note-target reminder"
```

---

### Task 4: Richer `convertToTask` options

**Files:**

- Modify: `apps/desktop/src/main/inbox/filing.ts`
- Test: `apps/desktop/src/main/inbox/filing.test.ts`

**Interfaces:**

- Produces: `convertToTask(itemId: string, input?: { projectId?: string; dueDate?: string | null; dueTime?: string | null; priority?: number }): Promise<{ success: boolean; taskId: string | null; error?: string }>`

- [x] **Step 1: Write the failing test**:

```ts
it('honours projectId, dueDate, dueTime and priority', async () => {
  const projectId = await seedProject({ name: 'Work' })
  const itemId = await seedInboxItem({ type: 'note', title: 'Send invoice' })
  const res = await convertToTask(itemId, {
    projectId,
    dueDate: '2099-03-01',
    dueTime: '14:00',
    priority: 2
  })
  expect(res.success).toBe(true)
  const task = db.select().from(tasks).where(eq(tasks.id, res.taskId!)).get()
  expect(task?.projectId).toBe(projectId)
  expect(task?.dueDate).toBe('2099-03-01')
  expect(task?.dueTime).toBe('14:00')
  expect(task?.priority).toBe(2)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- filing.test.ts -t "honours projectId"`
Expected: FAIL — current `convertToTask` ignores options.

- [x] **Step 3: Implement** — add the optional `input` param and thread defaults into `insertTask`:

```ts
export async function convertToTask(
  itemId: string,
  input?: {
    projectId?: string
    dueDate?: string | null
    dueTime?: string | null
    priority?: number
  }
): Promise<{ success: boolean; taskId: string | null; error?: string }> {
  // ...existing item / filed checks unchanged...
  const inboxProject = getInboxProject(db)
  const projectId = input?.projectId ?? inboxProject?.id
  if (!projectId) return { success: false, taskId: null, error: 'No target project found' }
  const position = getNextTaskPosition(db, projectId, null)
  const task = insertTask(db, {
    id: taskId,
    projectId,
    statusId: null,
    parentId: null,
    title,
    description,
    priority: input?.priority ?? 0,
    position,
    dueDate: input?.dueDate ?? null,
    dueTime: input?.dueTime ?? null,
    startDate: null,
    repeatConfig: null,
    repeatFrom: null,
    sourceNoteId: null
  })
  // ...rest unchanged (setTaskTags, markItemAsFiled 'task', emit, syncTaskCreate)...
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- filing.test.ts -t convertToTask`
Expected: PASS (all convertToTask tests, including Task 1's provenance test).

- [x] **Step 5: Commit**

```bash
git add apps/desktop/src/main/inbox/filing.ts apps/desktop/src/main/inbox/filing.test.ts
git commit -m "feat(inbox): convertToTask accepts project/due/priority options"
```

---

### Task 5: IPC + preload wiring

**Files:**

- Modify: `packages/contracts/src/ipc-channels.ts` (`InboxChannels.invoke`)
- Modify: `apps/desktop/src/main/inbox/domain.ts` + `apps/desktop/src/main/inbox/index.ts` (export new fns)
- Modify: `apps/desktop/src/main/ipc/inbox-handlers.ts` (register + unregister)
- Modify: inbox preload api (`apps/desktop/src/preload/api/inbox.ts` or equivalent) + `apps/desktop/src/preload/index.d.ts`
- Verify: `apps/desktop/src/main/ipc/index.test.ts` mock (add the new handlers if it asserts the handler set)

**Interfaces:**

- Produces: `window.api.inbox.convertToEvent(itemId, input)`, `window.api.inbox.convertToReminder(itemId, input)`, `window.api.inbox.convertToTask(itemId, input?)`.

- [x] **Step 1: Add channel ids** in `ipc-channels.ts` under `InboxChannels.invoke`:

```ts
CONVERT_TO_EVENT: 'inbox:convert-to-event',
CONVERT_TO_REMINDER: 'inbox:convert-to-reminder',
```

- [x] **Step 2: Export from the domain** — in `domain.ts` add `convertToEvent`, `convertToReminder` to the inbox domain object (next to `convertToNote`, `convertToTask`), and re-export from `index.ts`.

- [x] **Step 3: Register handlers** in `inbox-handlers.ts` (beside the existing CONVERT_TO_NOTE/TASK at line ~142), and add `ipcMain.removeHandler(...)` for both in the teardown block (line ~209):

```ts
ipcMain.handle(InboxChannels.invoke.CONVERT_TO_TASK, (_, itemId, input) =>
  inboxDomain.convertToTask(itemId, input)
)
ipcMain.handle(InboxChannels.invoke.CONVERT_TO_EVENT, (_, itemId, input) =>
  inboxDomain.convertToEvent(itemId, input)
)
ipcMain.handle(InboxChannels.invoke.CONVERT_TO_REMINDER, (_, itemId, input) =>
  inboxDomain.convertToReminder(itemId, input)
)
```

- [x] **Step 4: Add preload methods** mirroring the existing `convertToTask` forwarder in the inbox preload api, and add the typed signatures in `preload/index.d.ts` (the hand-maintained inbox `WindowAPI` block — match the surrounding style).

- [x] **Step 5: Regenerate + check the IPC map**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: PASS ("invoke map up to date").

- [x] **Step 6: Typecheck + main tests**

Run: `pnpm typecheck && pnpm --filter @memry/desktop test:main -- inbox`
Expected: PASS (update `ipc/index.test.ts` mock if it enumerates handlers).

- [x] **Step 7: Commit**

```bash
git add packages/contracts/src/ipc-channels.ts apps/desktop/src/main/inbox apps/desktop/src/preload apps/desktop/src/main/ipc
git commit -m "feat(inbox): wire convert-to-event/reminder IPC + preload"
```

---

### Task 6: Inbox UI — Event/Reminder buttons, forms, binary gating, badges

**Files:**

- Modify: the inbox detail panel convert/filing surface (`apps/desktop/src/renderer/src/components/inbox-detail/filing-section.tsx` and/or `inbox-detail-panel.tsx`)
- Modify: the inbox mutations hook (`apps/desktop/src/renderer/src/hooks/use-inbox-mutations.ts`) — add `convertToEvent` / `convertToReminder` mutations + extend `convertToTask`
- Modify: the filed/done list item to render a badge from `filedAction`
- Test: a renderer test beside the panel (mirror existing inbox-detail tests)
- i18n: add keys to `packages/i18n` (run `pnpm --filter @memry/desktop i18n:check`)

**Interfaces:**

- Consumes: `window.api.inbox.convertToEvent/Reminder/Task` from Task 5.

- [x] **Step 1: Write the failing renderer test** — binary gating:

```tsx
it('disables Task/Event/Reminder for binary items, Note stays enabled', () => {
  render(<FilingSection item={{ ...baseItem, type: 'pdf' }} {...handlers} />)
  expect(screen.getByRole('button', { name: /note/i })).toBeEnabled()
  expect(screen.getByRole('button', { name: /event/i })).toBeDisabled()
  expect(screen.getByRole('button', { name: /reminder/i })).toBeDisabled()
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `vitest run --config config/vitest.config.ts --project renderer apps/desktop/src/renderer/src/components/inbox-detail/filing-section.test.tsx`
Expected: FAIL — no Event/Reminder buttons yet.

- [x] **Step 3: Add mutations** in `use-inbox-mutations.ts` mirroring the existing `convertToTask` mutation: `convertToEvent(itemId, input)`, `convertToReminder(itemId, input)`, and extend `convertToTask` to pass `input`. On success invalidate `inboxKeys.lists()` + `inboxKeys.item(id)` and show a success toast with an Open action.

- [x] **Step 4: Add the UI** in the convert surface:
  - Buttons: Note · Task · Event · Reminder. Compute `const isBinary = ['image','pdf','video','clip'].includes(item.type)`; disable Task/Event/Reminder when `isBinary`, with a tooltip using the i18n key `inbox.convert.binaryOnlyNote`.
  - Each non-note button opens a compact popover form (use existing popover + Input/date primitives):
    - Task: project select (existing `useProjects`) · due date · due time · priority. All optional → calls `convertToTask(item.id, {...})`.
    - Event: start (required `datetime-local`) · end · all-day checkbox · location → `convertToEvent(item.id, { startAt, endAt, isAllDay, location })` (convert local datetime to ISO).
    - Reminder: datetime (required, future) → `convertToReminder(item.id, { remindAt })`.
  - Use logical Tailwind props only.

- [ ] **Step 5: Add the filed badge** — in the filed/done list item, map `filedAction` → label/icon: `task → Task`, `event → Event`, `reminder → Reminder`, `note|linked → Note`, `folder → Folder`. Click routes to the target (task workspace / calendar / note).

- [x] **Step 6: Run the renderer test + i18n**

Run: `vitest run --config config/vitest.config.ts --project renderer apps/desktop/src/renderer/src/components/inbox-detail/filing-section.test.tsx`
Then: `pnpm --filter @memry/desktop i18n:check`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer packages/i18n
git commit -m "feat(inbox): convert-to-event/reminder UI + task options + filed badges"
```

---

### Task 7: Full verification + docs gate

- [ ] **Step 1: Run the full gate set**

```bash
pnpm typecheck
pnpm lint
pnpm test:desktop
pnpm ipc:check
pnpm check:contracts
pnpm check:architecture
git diff --check
```

Expected: all PASS. Fix any failure in the task that introduced it.

- [ ] **Step 2: Docs gate** (desktop change → docs routing)

```bash
pnpm docs:impact --base origin/main --strict
```

If `missing-docs`, run `pnpm docs:ai-update --base origin/main` or update `apps/docs/src/**` by hand, then re-run `--strict` and `pnpm docs:build`.

- [ ] **Step 3: Manual two-profile smoke (optional but recommended)**

`pnpm --filter @memry/desktop dev:a` — capture a text item, Convert → Event (future time): event appears on the calendar; the item leaves the active inbox with a "→ Event" badge. Repeat for Reminder (note created + reminder scheduled) and Task (with a due date → also shows on the calendar as a task chip). Confirm binary (PDF) shows only Note enabled.

- [ ] **Step 4: Commit any doc updates**

```bash
git add apps/docs
git commit -m "docs: inbox conversion engine"
```

## Self-Review notes

- Spec coverage: Part A → Task 1; Part B → Task 2; Part C → Task 3; Part D → Task 4; Part E → Task 5; Part F → Task 6; gates → Task 7. All covered.
- The two "confirm the exact shape" steps (CalendarChannels.CHANGED payload in Task 2; reminder create import in Task 3) are real lookups against named files, not placeholders — the implementer reads one named line and matches it.
- Type consistency: `convertToEvent` returns `{ eventId }`, `convertToReminder` returns `{ noteId }`, `convertToTask` returns `{ taskId }`; `FilingAction` union is identical across all three definitions and the two main signatures.
