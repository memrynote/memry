# Calendar: Inbox Snooze Click Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the silent no-op when a user clicks a snoozed inbox item on the calendar with a small floating popover offering three actions: open in inbox, unsnooze now, reschedule.

**Architecture:** Mirror the existing `CalendarEventPopover` and the planned `CalendarTaskPopover` patterns. Add a separate `inboxSnoozePopoverState` slot in `CalendarPage` (don't union it with `popoverState` — concerns differ). Fork at `handleSelectItem` on `item.sourceType === 'inbox_snooze'`. Reuse `inboxService.snooze` / `inboxService.unsnooze` IPC — no new contracts. Reuse `<SnoozePicker>` for the reschedule path so we get the existing preset list + custom date/time dialog for free.

**Tech Stack:** React 19, TypeScript, Radix UI, Vitest + @testing-library/react, Playwright (Electron E2E), Tailwind (logical/RTL classes), electron-log, react-i18next, react-router-dom (existing route navigation).

**Out of scope (separate plans):**

- Reminder click handling (`sourceType === 'reminder'`) — different lifecycle (4-state enum) needs its own design pass.
- Visual mute treatment for snoozed chips on the calendar.
- Highlighting the destination inbox item after navigation.

---

## File Structure

**Create:**

```
apps/desktop/src/renderer/src/components/calendar/
├── calendar-inbox-snooze-popover.tsx           — popover component
└── calendar-inbox-snooze-popover.test.tsx      — component tests

apps/desktop/tests/e2e/
└── calendar-inbox-snooze-click.e2e.ts          — E2E spec
```

**Modify:**

```
apps/desktop/src/renderer/src/pages/calendar.tsx                              — add state, handler branch, action callbacks
apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx          — pass through new popover props + render
packages/i18n/src/locales/en/calendar.json                                    — add 4 i18n strings
```

---

## Design Decisions (locked)

1. **Three actions in popover:** Open in inbox, Unsnooze now, Reschedule. No "delete" or "convert to task" — those belong on the inbox surface.
2. **Reuse `<SnoozePicker>`** for the reschedule action — its existing preset list (later today / tomorrow / this weekend / next week / custom) covers the use case. Don't re-invent.
3. **Use `descriptionPreview` from the projection item** — already populated. No extra `inbox.get` IPC fetch needed for the popover.
4. **Anchor positioning:** reuse the same `AnchorRect` + `computePopoverPosition` helpers the event popover uses.
5. **Navigation:** "Open in inbox" calls `navigate('/inbox')` via `react-router-dom`. Item highlighting on the inbox page is deferred (separate plan).
6. **Cache invalidation:** after unsnooze/reschedule succeeds, invalidate `['calendar', 'range']` query so the chip moves/disappears immediately.

---

## Task 1: Build `<CalendarInboxSnoozePopover>` Component

**Files:**

- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-inbox-snooze-popover.tsx`
- Test: `apps/desktop/src/renderer/src/components/calendar/calendar-inbox-snooze-popover.test.tsx`

This is a presentational component — receives data + callbacks, renders UI, fires callbacks. No internal data fetching, no IPC. State for "reschedule submenu open" is fine (transient UI).

- [ ] **Step 1.1: Write the failing component test**

```typescript
// apps/desktop/src/renderer/src/components/calendar/calendar-inbox-snooze-popover.test.tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarInboxSnoozePopover } from './calendar-inbox-snooze-popover'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const baseItem: CalendarProjectionItem = {
  projectionId: 'inbox_snooze:item-123',
  sourceType: 'inbox_snooze',
  sourceId: 'item-123',
  title: 'Read this article',
  descriptionPreview: 'A long preview of inbox content.',
  startAt: '2026-04-30T09:00:00.000Z',
  endAt: null,
  isAllDay: false,
  timezone: 'UTC',
  visualType: 'snooze',
  editability: { canEdit: true, canDelete: true, writebackMode: 'local' },
  source: {
    provider: null,
    calendarSourceId: null,
    title: 'Memry Inbox',
    color: null,
    kind: null,
    isMemryManaged: true
  },
  binding: null,
  snoozeOffsetMinutes: null
}

const baseAnchor = { x: 100, y: 100, width: 120, height: 24 }

describe('CalendarInboxSnoozePopover', () => {
  it('renders the inbox item title and preview', () => {
    render(
      <CalendarInboxSnoozePopover
        item={baseItem}
        anchorRect={baseAnchor}
        onOpenInInbox={vi.fn()}
        onUnsnooze={vi.fn()}
        onReschedule={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(screen.getByText('Read this article')).toBeInTheDocument()
    expect(screen.getByText(/A long preview/)).toBeInTheDocument()
  })

  it('calls onOpenInInbox with the item id when "Open in inbox" is clicked', async () => {
    const user = userEvent.setup()
    const onOpenInInbox = vi.fn()
    render(
      <CalendarInboxSnoozePopover
        item={baseItem}
        anchorRect={baseAnchor}
        onOpenInInbox={onOpenInInbox}
        onUnsnooze={vi.fn()}
        onReschedule={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: /open in inbox/i }))
    expect(onOpenInInbox).toHaveBeenCalledWith('item-123')
  })

  it('calls onUnsnooze with the item id when "Unsnooze now" is clicked', async () => {
    const user = userEvent.setup()
    const onUnsnooze = vi.fn()
    render(
      <CalendarInboxSnoozePopover
        item={baseItem}
        anchorRect={baseAnchor}
        onOpenInInbox={vi.fn()}
        onUnsnooze={onUnsnooze}
        onReschedule={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: /unsnooze now/i }))
    expect(onUnsnooze).toHaveBeenCalledWith('item-123')
  })
})
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test -- calendar-inbox-snooze-popover`
Expected: FAIL with "Cannot find module './calendar-inbox-snooze-popover'"

- [ ] **Step 1.3: Write minimal popover implementation**

```tsx
// apps/desktop/src/renderer/src/components/calendar/calendar-inbox-snooze-popover.tsx
import { useEffect, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'

import { Button } from '@/components/ui/button'
import { SnoozePicker } from '@/components/snooze/snooze-picker'
import { Inbox, Bell, Clock } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { AnchorRect } from './types'
import { POPOVER_WIDTH, computePopoverPosition } from './popover-position'
import type { CalendarProjectionItem } from '@/services/calendar-service'

interface CalendarInboxSnoozePopoverProps {
  item: CalendarProjectionItem
  anchorRect: AnchorRect
  onOpenInInbox: (itemId: string) => void
  onUnsnooze: (itemId: string) => void | Promise<void>
  onReschedule: (itemId: string, snoozeUntil: string) => void | Promise<void>
  onDismiss: () => void
}

export function CalendarInboxSnoozePopover({
  item,
  anchorRect,
  onOpenInInbox,
  onUnsnooze,
  onReschedule,
  onDismiss
}: CalendarInboxSnoozePopoverProps): React.JSX.Element {
  const { t } = useT('calendar')
  const containerRef = useRef<HTMLDivElement>(null)
  const position = computePopoverPosition(anchorRect, POPOVER_WIDTH)

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current) return
      if (containerRef.current.contains(event.target as Node)) return
      onDismiss()
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onDismiss()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onDismiss])

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={t('phaseI.inboxSnoozePopover.title')}
      style={{ position: 'fixed', top: position.top, left: position.left, width: POPOVER_WIDTH }}
      className={cn(
        'z-50 rounded-lg border border-border bg-popover p-4 shadow-lg',
        'flex flex-col gap-3'
      )}
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
        {item.descriptionPreview && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{item.descriptionPreview}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={() => onOpenInInbox(item.sourceId)}
        >
          <Inbox className="me-2 h-4 w-4" />
          {t('phaseI.inboxSnoozePopover.openInInbox')}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={() => void onUnsnooze(item.sourceId)}
        >
          <Bell className="me-2 h-4 w-4" />
          {t('phaseI.inboxSnoozePopover.unsnoozeNow')}
        </Button>

        <SnoozePicker
          onSnooze={(snoozeUntil) => void onReschedule(item.sourceId, snoozeUntil)}
          trigger={
            <Button variant="ghost" size="sm" className="justify-start">
              <Clock className="me-2 h-4 w-4" />
              {t('phaseI.inboxSnoozePopover.reschedule')}
            </Button>
          }
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test -- calendar-inbox-snooze-popover`
Expected: PASS — all 3 tests green.

- [ ] **Step 1.5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-inbox-snooze-popover.tsx \
        apps/desktop/src/renderer/src/components/calendar/calendar-inbox-snooze-popover.test.tsx
git commit -m "feat(calendar): add CalendarInboxSnoozePopover component

Renders a small floating popover for snoozed inbox items with three
actions: open in inbox, unsnooze now, reschedule (via SnoozePicker).
Mirrors the positioning/dismiss pattern of CalendarEventPopover."
```

---

## Task 2: Add i18n Strings

**Files:**

- Modify: `packages/i18n/src/locales/en/calendar.json`

The popover hardcoded keys in Task 1 must resolve. Add four entries under `phaseI.inboxSnoozePopover`.

- [ ] **Step 2.1: Open the JSON file and locate `phaseI`**

```bash
# Confirm structure
head -100 packages/i18n/src/locales/en/calendar.json | grep -n phaseI
```

Expected: a `"phaseI": { ... }` object exists.

- [ ] **Step 2.2: Add the new keys under `phaseI`**

Insert this object as a child of `phaseI` (alphabetical placement preferred):

```json
"inboxSnoozePopover": {
  "title": "Snoozed inbox item",
  "openInInbox": "Open in inbox",
  "unsnoozeNow": "Unsnooze now",
  "reschedule": "Reschedule"
}
```

- [ ] **Step 2.3: Verify JSON validity**

Run: `node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/calendar.json','utf8'))"`
Expected: no output (parse OK).

- [ ] **Step 2.4: Verify the popover test still passes (now with real strings)**

Run: `pnpm --filter @memry/desktop test -- calendar-inbox-snooze-popover`
Expected: PASS — tests use regex matchers (`/open in inbox/i`) so they tolerate the real strings.

- [ ] **Step 2.5: Commit**

```bash
git add packages/i18n/src/locales/en/calendar.json
git commit -m "feat(i18n): add inboxSnoozePopover strings to en/calendar"
```

---

## Task 3: Wire State, Handler Branch, and Actions in `CalendarPage`

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/calendar.tsx`

Add `inboxSnoozePopoverState`, branch in `handleSelectItem`, three action handlers, and pass props through to `CalendarShell`.

- [ ] **Step 3.1: Add new imports at top of `calendar.tsx`**

After the existing `import { useEffect, useMemo, useRef, useState } from 'react'` and the `extractErrorMessage` / `createLogger` imports, add:

```typescript
import { useNavigate } from 'react-router-dom'
import { inboxService } from '@/services/inbox-service'
```

If `react-router-dom` is not the routing primitive — verify with `grep -rn "useNavigate\|BrowserRouter\|HashRouter" apps/desktop/src/renderer/src` — substitute the actual hook used by the renderer.

- [ ] **Step 3.2: Add state slot (after the existing `popoverState` declaration around line 187)**

Insert immediately after the existing `popoverState` useState block:

```typescript
const [inboxSnoozePopoverState, setInboxSnoozePopoverState] = useState<{
  item: CalendarProjectionItem
  anchorRect: AnchorRect
} | null>(null)
const navigate = useNavigate()
```

- [ ] **Step 3.3: Add `inbox_snooze` branch to `handleSelectItem`**

Locate `handleSelectItem` (currently line 363). Insert the new branch BEFORE the `if (item.sourceType !== 'external_event') return` guard:

```typescript
if (item.sourceType === 'inbox_snooze') {
  setInboxSnoozePopoverState({ item, anchorRect: rect })
  return
}
```

The complete handler should read:

```typescript
const handleSelectItem = async (item: CalendarProjectionItem, rect: AnchorRect) => {
  if (item.sourceType === 'event') {
    const record = await calendarService.getEvent(item.sourceId).catch(() => null)
    setPopoverState({
      mode: 'edit',
      eventId: item.sourceId,
      draft: createDraftFromItem(item),
      anchorRect: rect,
      readOnlyMetadata: record
        ? {
            attendees: record.attendees,
            reminders: record.reminders,
            visibility: record.visibility,
            conferenceData: record.conferenceData
          }
        : undefined
    })
    return
  }

  if (item.sourceType === 'inbox_snooze') {
    setInboxSnoozePopoverState({ item, anchorRect: rect })
    return
  }

  if (item.sourceType !== 'external_event') return

  const settings = await window.api.settings.getCalendarGoogleSettings()
  if (settings.promoteConfirmDismissed) {
    await runPromote(item, rect, { dontAskAgain: false })
    return
  }

  setPendingPromote({ item, anchorRect: rect })
}
```

- [ ] **Step 3.4: Add the three action handlers**

Place these immediately after `handleSelectItem` (around line 393):

```typescript
const handleInboxSnoozeOpenInInbox = (itemId: string) => {
  setInboxSnoozePopoverState(null)
  navigate(`/inbox?item=${encodeURIComponent(itemId)}`)
}

const handleInboxSnoozeUnsnooze = async (itemId: string) => {
  try {
    const result = await inboxService.unsnooze(itemId)
    if (!result.success) {
      throw new Error(result.error ?? 'Unsnooze failed.')
    }
    await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
    setInboxSnoozePopoverState(null)
  } catch (err) {
    log.error('Failed to unsnooze inbox item', {
      itemId,
      error: extractErrorMessage(err, 'Could not unsnooze.')
    })
  }
}

const handleInboxSnoozeReschedule = async (itemId: string, snoozeUntil: string) => {
  try {
    const result = await inboxService.snooze({ itemId, snoozeUntil })
    if (!result.success) {
      throw new Error(result.error ?? 'Reschedule failed.')
    }
    await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
    setInboxSnoozePopoverState(null)
  } catch (err) {
    log.error('Failed to reschedule inbox item', {
      itemId,
      error: extractErrorMessage(err, 'Could not reschedule.')
    })
  }
}
```

> **Note for executor:** the exact shape of `inboxService.unsnooze(itemId)` / `inboxService.snooze({...})` and their return values should match what `inbox-service.test.ts` mocks (line 30, 88). Verify by reading `apps/desktop/src/renderer/src/services/inbox-service.ts` and the corresponding `@memry/rpc/inbox` types. If a returned value lacks `.success`, drop the `if (!result.success)` guard.

- [ ] **Step 3.5: Pass new props to `<CalendarShell>`**

In the existing `<CalendarShell ... />` JSX block (around line 499-560), add these props:

```tsx
inboxSnoozePopoverState={inboxSnoozePopoverState}
onInboxSnoozeOpenInInbox={handleInboxSnoozeOpenInInbox}
onInboxSnoozeUnsnooze={handleInboxSnoozeUnsnooze}
onInboxSnoozeReschedule={handleInboxSnoozeReschedule}
onInboxSnoozePopoverDismiss={() => setInboxSnoozePopoverState(null)}
```

- [ ] **Step 3.6: Run typecheck to confirm CalendarShell prop interface needs Task 4**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: FAIL with errors on the new prop names ("Property 'inboxSnoozePopoverState' does not exist on type 'CalendarShellProps'"). This is the trigger for Task 4.

- [ ] **Step 3.7: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/calendar.tsx
git commit -m "feat(calendar): wire inbox_snooze branch in handleSelectItem

Adds popover state slot, three action handlers (open in inbox,
unsnooze, reschedule), and prop passthrough to CalendarShell.
Typecheck will fail until CalendarShell props are extended."
```

---

## Task 4: Pass-through and Render in `CalendarShell`

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx`

Extend the props interface, accept the new props, render the popover when state is non-null.

- [ ] **Step 4.1: Add import for the new component**

Below the existing `CalendarEventPopover` import (line 7):

```typescript
import { CalendarInboxSnoozePopover } from './calendar-inbox-snooze-popover'
```

- [ ] **Step 4.2: Extend `CalendarShellProps` interface**

Add these fields to the existing `interface CalendarShellProps { ... }` (line 24-66). Place them adjacent to `popoverState`:

```typescript
inboxSnoozePopoverState: {
  item: CalendarProjectionItem
  anchorRect: AnchorRect
} | null
onInboxSnoozeOpenInInbox: (itemId: string) => void
onInboxSnoozeUnsnooze: (itemId: string) => void | Promise<void>
onInboxSnoozeReschedule: (itemId: string, snoozeUntil: string) => void | Promise<void>
onInboxSnoozePopoverDismiss: () => void
```

- [ ] **Step 4.3: Destructure new props in the function signature**

In the `export function CalendarShell({ ... }: CalendarShellProps)` destructure (line 68+), add:

```typescript
inboxSnoozePopoverState,
onInboxSnoozeOpenInInbox,
onInboxSnoozeUnsnooze,
onInboxSnoozeReschedule,
onInboxSnoozePopoverDismiss,
```

- [ ] **Step 4.4: Render the popover next to the existing `popoverState && (...)` block**

Find the existing render around line 286:

```tsx
{popoverState && (
  <CalendarEventPopover
    anchorRect={popoverState.anchorRect}
    ...
  />
)}
```

Add immediately after that block:

```tsx
{inboxSnoozePopoverState && (
  <CalendarInboxSnoozePopover
    item={inboxSnoozePopoverState.item}
    anchorRect={inboxSnoozePopoverState.anchorRect}
    onOpenInInbox={onInboxSnoozeOpenInInbox}
    onUnsnooze={onInboxSnoozeUnsnooze}
    onReschedule={onInboxSnoozeReschedule}
    onDismiss={onInboxSnoozePopoverDismiss}
  />
)}
```

- [ ] **Step 4.5: Run typecheck**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS.

- [ ] **Step 4.6: Run renderer test suite**

Run: `pnpm --filter @memry/desktop test`
Expected: PASS — no regressions in existing calendar / inbox suites.

- [ ] **Step 4.7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx
git commit -m "feat(calendar): render CalendarInboxSnoozePopover in shell

Extends CalendarShellProps with the inboxSnoozePopoverState slot and
five callbacks. Renders the popover when state is non-null, mirroring
the existing event popover render path."
```

---

## Task 5: E2E Coverage for the Click Flow

**Files:**

- Create: `apps/desktop/tests/e2e/calendar-inbox-snooze-click.e2e.ts`

A Playwright spec that drives the Electron app, seeds a snoozed inbox item, navigates to the calendar, clicks the chip, and verifies the popover appears + each action works.

- [ ] **Step 5.1: Identify an existing E2E spec to mirror**

Run: `ls apps/desktop/tests/e2e/`
Expected: see `*.e2e.ts` files. Pick the simplest calendar-related one (e.g., `calendar-create-event.e2e.ts` if present) as the structural template.

- [ ] **Step 5.2: Read the chosen template**

Note the patterns for: launching Electron, signing in / opening a vault, seeding test data, navigating routes, dismissing dialogs.

- [ ] **Step 5.3: Write the failing E2E spec**

```typescript
// apps/desktop/tests/e2e/calendar-inbox-snooze-click.e2e.ts
import { test, expect } from './fixtures'

test.describe('Calendar: snoozed inbox item click', () => {
  test('opens popover with three actions', async ({ electronApp, page, seed }) => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await seed.inbox.captureText({ content: 'Test snoozed item' })
    const item = await seed.inbox.snoozeMostRecent({ snoozeUntil: tomorrow })

    await page.goto('/calendar')
    await page.click('[data-testid="calendar-view-day"]')
    await page.goto(`/calendar?date=${tomorrow.split('T')[0]}`)

    const chip = page.locator('[data-testid^="calendar-item-chip"]', {
      hasText: 'Test snoozed item'
    })
    await expect(chip).toBeVisible()
    await chip.click()

    await expect(page.getByRole('dialog', { name: /snoozed inbox item/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /open in inbox/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /unsnooze now/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /reschedule/i })).toBeVisible()
  })

  test('Unsnooze now removes the chip from the calendar', async ({ page, seed }) => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await seed.inbox.captureText({ content: 'Item to unsnooze' })
    await seed.inbox.snoozeMostRecent({ snoozeUntil: tomorrow })

    await page.goto(`/calendar?date=${tomorrow.split('T')[0]}`)
    const chip = page.locator('[data-testid^="calendar-item-chip"]', {
      hasText: 'Item to unsnooze'
    })
    await chip.click()
    await page.getByRole('button', { name: /unsnooze now/i }).click()

    await expect(chip).not.toBeVisible({ timeout: 5000 })
  })

  test('Open in inbox navigates to /inbox', async ({ page, seed }) => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await seed.inbox.captureText({ content: 'Item to open' })
    await seed.inbox.snoozeMostRecent({ snoozeUntil: tomorrow })

    await page.goto(`/calendar?date=${tomorrow.split('T')[0]}`)
    const chip = page.locator('[data-testid^="calendar-item-chip"]', {
      hasText: 'Item to open'
    })
    await chip.click()
    await page.getByRole('button', { name: /open in inbox/i }).click()

    await expect(page).toHaveURL(/\/inbox/)
  })
})
```

> **Note for executor:** the `seed.inbox.snoozeMostRecent` helper may not exist. If the existing E2E fixture (`./fixtures.ts`) doesn't expose an inbox-snooze seeder, add one. The seeder should call the inbox IPC directly to: (a) create an inbox item, (b) snooze it via `inboxService.snooze`, returning the item ID. Pattern after any existing `seed.calendar.*` helper.

- [ ] **Step 5.4: Build the renderer + main bundles**

Per `MEMORY.md`: E2E tests run against the built bundle, NOT source.

Run: `pnpm --filter @memry/desktop build` (or the project's standard rebuild command — check `package.json` scripts)
Expected: build succeeds.

- [ ] **Step 5.5: Run the new E2E spec**

Run: `pnpm --filter @memry/desktop test:e2e -- calendar-inbox-snooze-click`
Expected: all 3 tests PASS.

- [ ] **Step 5.6: Commit**

```bash
git add apps/desktop/tests/e2e/calendar-inbox-snooze-click.e2e.ts
git commit -m "test(e2e): cover calendar inbox-snooze click → popover → actions"
```

---

## Verification Checklist (run before opening PR)

- [ ] `pnpm lint` — clean
- [ ] `pnpm typecheck` — clean (or only pre-existing failures from MEMORY.md)
- [ ] `pnpm test` — green
- [ ] `pnpm test:e2e -- calendar-inbox-snooze-click` — green
- [ ] Manual smoke: snooze an inbox item, navigate to calendar on the snooze date, click chip → popover appears → each action works
- [ ] CHANGELOG.md updated with `feat(calendar): inbox-snooze chips on calendar are now clickable`

---

## Self-Review Notes (for plan author)

**Spec coverage:** This plan covers exactly what was discussed in the brainstorm — three actions, separate popover state, no shared layout component (YAGNI), inbox_snooze only.

**Reminder gap (intentional):** Reminder click handling is *not* covered. A user clicking a `sourceType === 'reminder'` chip will still hit the silent no-op until a follow-up plan ships.

**Type assumptions to verify in execution:**
- `inboxService.snooze({ itemId, snoozeUntil })` payload shape (test file shows this exact shape).
- `inboxService.unsnooze(itemId)` accepts a bare string (handler uses `(_, itemId) => inboxDomain.unsnooze(itemId)`).
- `useNavigate` from `react-router-dom` — confirm before Task 3 import.

**Risks:**
- Nesting `<SnoozePicker>` (a Radix DropdownMenu) inside a custom popover may have z-index / portal interactions. If the dropdown renders behind/outside the popover, fix by passing the SnoozePicker's portal target explicitly (DropdownMenu allows a `container` prop), or by repositioning the dropdown to render inline.
- Popover positioning at the screen edge (right column of month view) may need clamping logic; reuse whatever `computePopoverPosition` already does for events.
