# Clock Format Setting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add app-wide "12h / 24h" clock format setting, wired through GeneralSettings and consumed by all 13 time formatting locations.

**Architecture:** Add `clockFormat: '12h' | '24h'` to the existing `GeneralSettingsSchema` (contracts). Create a shared `time-format.ts` utility with three formatters. Plumb `clockFormat` into all consumer call sites — React components read via `useGeneralSettings()`, pure utility functions accept `clockFormat` as a parameter.

**Tech Stack:** Zod (contracts), React hooks, Intl.DateTimeFormat, existing settings IPC plumbing.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/contracts/src/settings-schemas.ts` | Add `clockFormat` to `GeneralSettingsSchema` + defaults |
| Create | `apps/desktop/src/renderer/src/lib/time-format.ts` | Shared time formatting utility (3 functions) |
| Create | `apps/desktop/src/renderer/src/lib/time-format.test.ts` | Unit tests for the utility |
| Modify | `apps/desktop/src/renderer/src/hooks/use-general-settings.ts` | Add `clockFormat` to DEFAULTS |
| Modify | `apps/desktop/src/renderer/src/pages/settings/general-section.tsx` | Add Time Format dropdown |
| Modify | `apps/desktop/src/renderer/src/components/calendar/calendar-day-view.tsx` | Use shared `formatHour` |
| Modify | `apps/desktop/src/renderer/src/components/calendar/calendar-week-view.tsx` | Use shared `formatHour` |
| Modify | `apps/desktop/src/renderer/src/components/calendar/calendar-year-view.tsx` | Use shared `formatTimeOfDay` |
| Modify | `apps/desktop/src/renderer/src/components/calendar/calendar-item-chip.tsx` | Use shared `formatTimeOfDay` |
| Modify | `apps/desktop/src/renderer/src/components/reminder/reminder-presets.ts` | Accept `clockFormat` param in `formatReminderDate` |
| Modify | `apps/desktop/src/renderer/src/components/snooze/snooze-presets.ts` | Accept `clockFormat` param in `formatSnoozeTime` |
| Modify | `apps/desktop/src/renderer/src/lib/inbox-utils.ts` | Accept `clockFormat` param in `formatTimestamp` |
| Modify | `apps/desktop/src/renderer/src/components/inbox-detail/content-section.tsx` | Use shared `formatTimeOfDay` |
| Modify | `apps/desktop/src/renderer/src/components/inbox-detail/reminder-detail.tsx` | Use shared `formatTimeOfDay` in `formatTriggerDate` |
| Modify | `apps/desktop/src/renderer/src/components/journal/todays-notes.tsx` | Use shared `formatTimeOfDay` |
| Modify | `apps/desktop/src/renderer/src/lib/task-utils/task-formatting.ts` | Accept `clockFormat` param in `formatTime` |
| Modify | Callers of `formatTime` from task-utils (6 files) | Pass `clockFormat` through |
| Modify | Callers of `formatReminderDate` (3 files) | Pass `clockFormat` through |
| Modify | Callers of `formatSnoozeTime` (3 files) | Pass `clockFormat` through |
| Modify | `apps/desktop/src/renderer/src/lib/inbox-utils.test.ts` | Update tests for new param |

---

### Task 1: Add `clockFormat` to GeneralSettings contract

**Files:**
- Modify: `packages/contracts/src/settings-schemas.ts:16-38`

- [ ] **Step 1: Add `clockFormat` to `GeneralSettingsSchema`**

In `packages/contracts/src/settings-schemas.ts`, add `clockFormat` to the schema and defaults:

```typescript
// In GeneralSettingsSchema (line 16):
export const GeneralSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'white', 'system']),
  fontSize: z.enum(['small', 'medium', 'large']),
  fontFamily: z.enum(['system', 'serif', 'sans-serif', 'monospace', 'gelasio', 'geist', 'inter']),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  startOnBoot: z.boolean(),
  language: z.string().min(2).max(5),
  onboardingCompleted: z.boolean(),
  createInSelectedFolder: z.boolean(),
  clockFormat: z.enum(['12h', '24h'])
})

// In GENERAL_SETTINGS_DEFAULTS (line 29):
export const GENERAL_SETTINGS_DEFAULTS: GeneralSettings = {
  theme: 'system',
  fontSize: 'medium',
  fontFamily: 'system',
  accentColor: '#6366f1',
  startOnBoot: false,
  language: 'en',
  onboardingCompleted: false,
  createInSelectedFolder: true,
  clockFormat: '12h'
}
```

- [ ] **Step 2: Update `use-general-settings.ts` DEFAULTS**

In `apps/desktop/src/renderer/src/hooks/use-general-settings.ts`, add `clockFormat` to the local DEFAULTS:

```typescript
const DEFAULTS: GeneralSettingsDTO = {
  theme: 'system',
  fontSize: 'medium',
  fontFamily: 'system',
  accentColor: '#6366f1',
  startOnBoot: false,
  language: 'en',
  onboardingCompleted: false,
  createInSelectedFolder: true,
  clockFormat: '12h'
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:node && pnpm typecheck:web`
Expected: PASS (the new field flows through `GeneralSettings` type automatically since the hook uses `GeneralSettingsDTO` from preload)

Note: If `GeneralSettingsDTO` is manually defined in preload types rather than inferred from the schema, you'll need to add `clockFormat: '12h' | '24h'` there too. Check `apps/desktop/src/preload/index.d.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/settings-schemas.ts apps/desktop/src/renderer/src/hooks/use-general-settings.ts
git commit -m "feat(settings): add clockFormat to GeneralSettings schema"
```

---

### Task 2: Create shared time formatting utility + tests

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/time-format.ts`
- Create: `apps/desktop/src/renderer/src/lib/time-format.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/desktop/src/renderer/src/lib/time-format.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { formatHour, formatTimeOfDay, formatTimeString } from './time-format'

describe('formatHour', () => {
  it('formats midnight as 12 AM in 12h mode', () => {
    expect(formatHour(0, '12h')).toBe('12 AM')
  })

  it('formats noon as 12 PM in 12h mode', () => {
    expect(formatHour(12, '12h')).toBe('12 PM')
  })

  it('formats 3 PM in 12h mode', () => {
    expect(formatHour(15, '12h')).toBe('3 PM')
  })

  it('formats 9 AM in 12h mode', () => {
    expect(formatHour(9, '12h')).toBe('9 AM')
  })

  it('formats midnight as 00:00 in 24h mode', () => {
    expect(formatHour(0, '24h')).toBe('00:00')
  })

  it('formats noon as 12:00 in 24h mode', () => {
    expect(formatHour(12, '24h')).toBe('12:00')
  })

  it('formats 15:00 in 24h mode', () => {
    expect(formatHour(15, '24h')).toBe('15:00')
  })

  it('formats 9:00 in 24h mode', () => {
    expect(formatHour(9, '24h')).toBe('09:00')
  })
})

describe('formatTimeOfDay', () => {
  it('formats date in 12h mode', () => {
    const date = new Date(2026, 3, 14, 14, 30)
    const result = formatTimeOfDay(date, '12h')
    expect(result).toMatch(/2:30\s*PM/i)
  })

  it('formats date in 24h mode', () => {
    const date = new Date(2026, 3, 14, 14, 30)
    const result = formatTimeOfDay(date, '24h')
    expect(result).toMatch(/14:30/)
  })

  it('formats midnight in 24h mode', () => {
    const date = new Date(2026, 3, 14, 0, 5)
    const result = formatTimeOfDay(date, '24h')
    expect(result).toMatch(/0:05|00:05/)
  })
})

describe('formatTimeString', () => {
  it('formats HH:MM in 12h mode', () => {
    expect(formatTimeString('14:30', '12h')).toBe('2:30 PM')
  })

  it('formats HH:MM in 24h mode', () => {
    expect(formatTimeString('14:30', '24h')).toBe('14:30')
  })

  it('formats midnight in 12h mode', () => {
    expect(formatTimeString('00:00', '12h')).toBe('12:00 AM')
  })

  it('formats midnight in 24h mode', () => {
    expect(formatTimeString('00:00', '24h')).toBe('00:00')
  })

  it('formats noon in 12h mode', () => {
    expect(formatTimeString('12:00', '12h')).toBe('12:00 PM')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/lib/time-format.test.ts`
Expected: FAIL — module `./time-format` not found

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/renderer/src/lib/time-format.ts`:

```typescript
import type { GeneralSettings } from '@memry/contracts/settings-schemas'

export type ClockFormat = GeneralSettings['clockFormat']

export function formatHour(hour: number, format: ClockFormat): string {
  if (format === '24h') {
    return `${String(hour).padStart(2, '0')}:00`
  }
  if (hour === 0) return '12 AM'
  if (hour < 12) return `${hour} AM`
  if (hour === 12) return '12 PM'
  return `${hour - 12} PM`
}

export function formatTimeOfDay(date: Date, format: ClockFormat): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: format === '12h'
  }).format(date)
}

export function formatTimeString(time: string, format: ClockFormat): string {
  const [hours, minutes] = time.split(':').map(Number)
  if (format === '24h') {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  }
  const period = hours >= 12 ? 'PM' : 'AM'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/lib/time-format.test.ts`
Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/time-format.ts apps/desktop/src/renderer/src/lib/time-format.test.ts
git commit -m "feat(settings): add shared time-format utility with tests"
```

---

### Task 3: Add Time Format setting to General settings UI

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/settings/general-section.tsx`

- [ ] **Step 1: Add clockFormat handler and UI**

Add a handler for clock format change and a new `SettingsGroup` with the time format dropdown. Add it after the "Startup" group (before "Tab Behavior"):

```typescript
// Add handler alongside the other handlers:
const handleClockFormatChange = useCallback(
  async (value: '12h' | '24h') => {
    const success = await updateGeneralSettings({ clockFormat: value })
    if (!success) toast.error('Failed to update time format')
  },
  [updateGeneralSettings]
)

// Add SettingsGroup in JSX after Startup group:
<SettingsGroup label="Date & Time">
  <SettingRow label="Time Format" description="12-hour or 24-hour clock">
    <Select value={generalSettings.clockFormat} onValueChange={handleClockFormatChange}>
      <SelectTrigger className={COMPACT_SELECT}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="12h">12-hour</SelectItem>
        <SelectItem value="24h">24-hour</SelectItem>
      </SelectContent>
    </Select>
  </SettingRow>
</SettingsGroup>
```

- [ ] **Step 2: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:node && pnpm typecheck:web`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/general-section.tsx
git commit -m "feat(settings): add time format dropdown to general settings UI"
```

---

### Task 4: Wire calendar views to use shared formatHour

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-day-view.tsx`
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-week-view.tsx`
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-year-view.tsx`
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-item-chip.tsx`

- [ ] **Step 1: Update `calendar-day-view.tsx`**

Remove local `formatHour` function (lines 12-17). Import from `time-format.ts` and `useGeneralSettings`. Pass `clockFormat` to `formatHour`:

```typescript
import { formatHour } from '@/lib/time-format'
import { useGeneralSettings } from '@/hooks/use-general-settings'

// Inside CalendarDayView component:
const { settings: { clockFormat } } = useGeneralSettings()

// In JSX, change {formatHour(hour)} to:
{formatHour(hour, clockFormat)}
```

Also pass `clockFormat` to `CalendarItemChip` — see step 3 below.

- [ ] **Step 2: Update `calendar-week-view.tsx`**

Same pattern as day view: remove local `formatHour` (lines 13-18), import shared one + hook:

```typescript
import { formatHour } from '@/lib/time-format'
import { useGeneralSettings } from '@/hooks/use-general-settings'

// Inside CalendarWeekView component:
const { settings: { clockFormat } } = useGeneralSettings()

// In JSX:
{formatHour(hour, clockFormat)}
```

- [ ] **Step 3: Update `calendar-item-chip.tsx`**

Replace local `formatTime` with shared `formatTimeOfDay`. Add `clockFormat` prop:

```typescript
import { formatTimeOfDay } from '@/lib/time-format'
import type { ClockFormat } from '@/lib/time-format'

// Remove the local formatTime function (lines 17-23)

interface CalendarItemChipProps {
  item: CalendarProjectionItem
  clockFormat?: ClockFormat
  onClick?: (item: CalendarProjectionItem) => void
}

export function CalendarItemChip({ item, clockFormat = '12h', onClick }: CalendarItemChipProps): React.JSX.Element {
  const timeLabel = item.isAllDay
    ? 'All day'
    : formatTimeOfDay(new Date(item.startAt), clockFormat)

  // In JSX, replace {formatTime(item)} with:
  {timeLabel}
```

Then update all `<CalendarItemChip>` usages in day-view and week-view to pass `clockFormat`:

```tsx
<CalendarItemChip item={item} clockFormat={clockFormat} onClick={onSelectItem} />
```

- [ ] **Step 4: Update `calendar-year-view.tsx`**

Replace local `formatPopoverTime` (lines 26-30) to use shared utility:

```typescript
import { formatTimeOfDay } from '@/lib/time-format'
import { useGeneralSettings } from '@/hooks/use-general-settings'

// Inside CalendarYearView component:
const { settings: { clockFormat } } = useGeneralSettings()

// Replace formatPopoverTime:
function formatPopoverTime(item: CalendarProjectionItem): string {
  if (item.isAllDay) return 'all-day'
  return formatTimeOfDay(new Date(item.startAt), clockFormat)
}
```

Note: `formatPopoverTime` uses `clockFormat` from outer scope (closure over component variable).

- [ ] **Step 5: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:node && pnpm typecheck:web`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/
git commit -m "feat(calendar): wire day/week/year views and item chip to clockFormat setting"
```

---

### Task 5: Wire reminder, snooze, inbox, and journal utilities

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/reminder/reminder-presets.ts`
- Modify: `apps/desktop/src/renderer/src/components/snooze/snooze-presets.ts`
- Modify: `apps/desktop/src/renderer/src/lib/inbox-utils.ts`
- Modify: `apps/desktop/src/renderer/src/components/inbox-detail/content-section.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox-detail/reminder-detail.tsx`
- Modify: `apps/desktop/src/renderer/src/components/journal/todays-notes.tsx`

- [ ] **Step 1: Update `reminder-presets.ts` — `formatReminderDate`**

Add `clockFormat` parameter. Replace the `toLocaleTimeString` call (line 244-248):

```typescript
import type { ClockFormat } from '@/lib/time-format'
import { formatTimeOfDay } from '@/lib/time-format'

export function formatReminderDate(date: Date, clockFormat: ClockFormat = '12h'): string {
  const now = new Date()
  const tomorrow = new Date(now)
  // ... existing logic ...

  const timeStr = formatTimeOfDay(date, clockFormat)

  // rest unchanged
```

- [ ] **Step 2: Update callers of `formatReminderDate` to pass `clockFormat`**

Three callers need updating:
1. `apps/desktop/src/renderer/src/components/reminder/reminder-picker.tsx` — uses `useGeneralSettings` to get `clockFormat`, pass to `formatReminderDate(date, clockFormat)`
2. `apps/desktop/src/renderer/src/components/journal/journal-reminder-button.tsx` — same pattern
3. `apps/desktop/src/renderer/src/components/note/note-reminder-button.tsx` — same pattern

In each file, add:
```typescript
import { useGeneralSettings } from '@/hooks/use-general-settings'
// Inside component:
const { settings: { clockFormat } } = useGeneralSettings()
// At call site:
formatReminderDate(new Date(nextReminder.remindAt), clockFormat)
```

Also update the re-export in `apps/desktop/src/renderer/src/components/reminder/index.ts` if needed (function signature changes are transparent for re-exports).

- [ ] **Step 3: Update `snooze-presets.ts` — `formatSnoozeTime`**

Add `clockFormat` parameter. Replace both `toLocaleTimeString` calls (lines 264-268 and 278-284):

```typescript
import type { ClockFormat } from '@/lib/time-format'
import { formatTimeOfDay } from '@/lib/time-format'

export function formatSnoozeTime(date: Date, clockFormat: ClockFormat = '12h'): string {
  // ... existing logic ...

  const timeStr = formatTimeOfDay(date, clockFormat)

  // For the else branch (lines 278-284), replace toLocaleDateString with:
  } else {
    const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return `${dateStr}, ${formatTimeOfDay(date, clockFormat)}`
  }
```

- [ ] **Step 4: Update callers of `formatSnoozeTime` to pass `clockFormat`**

Three callers need updating:
1. `apps/desktop/src/renderer/src/components/snooze/snooze-picker.tsx` — add `useGeneralSettings`, pass `clockFormat`
2. `apps/desktop/src/renderer/src/components/inbox-detail/reminder-detail.tsx` — add `useGeneralSettings`, pass `clockFormat`

In each file:
```typescript
import { useGeneralSettings } from '@/hooks/use-general-settings'
const { settings: { clockFormat } } = useGeneralSettings()
// At call sites:
formatSnoozeTime(date, clockFormat)
```

- [ ] **Step 5: Update `inbox-utils.ts` — `formatTimestamp`**

Add `clockFormat` parameter:

```typescript
import type { ClockFormat } from '@/lib/time-format'
import { formatTimeOfDay } from '@/lib/time-format'

export const formatTimestamp = (
  timestamp: Date,
  period: TimePeriod,
  clockFormat: ClockFormat = '12h'
): string => {
  if (period === 'TODAY' || period === 'YESTERDAY') {
    return formatTimeOfDay(timestamp, clockFormat)
  }
  // OLDER branch unchanged — date only, no time
  return timestamp.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  })
}
```

Note: `formatTimestamp` is currently not imported by any component (only used in test file), so no callers to update. Update the test file to cover the new parameter — see Task 7.

- [ ] **Step 6: Update `content-section.tsx` inline time formatting**

Replace the inline `toLocaleTimeString` call (lines 78-82) with shared utility:

```typescript
import { formatTimeOfDay } from '@/lib/time-format'
import { useGeneralSettings } from '@/hooks/use-general-settings'

// Inside component:
const { settings: { clockFormat } } = useGeneralSettings()

// Replace inline toLocaleTimeString:
const timeStr = formatTimeOfDay(d, clockFormat)
```

- [ ] **Step 7: Update `reminder-detail.tsx` — `formatTriggerDate`**

Replace the inline `toLocaleDateString` with `hour12` (lines 30-39):

```typescript
import { formatTimeOfDay } from '@/lib/time-format'
import { useGeneralSettings } from '@/hooks/use-general-settings'

// Inside component (not the standalone function — move to component scope):
const { settings: { clockFormat } } = useGeneralSettings()

// Either inline it or pass clockFormat:
function formatTriggerDate(isoString: string, clockFormat: ClockFormat): string {
  const date = new Date(isoString)
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${dateStr}, ${formatTimeOfDay(date, clockFormat)}`
}
```

- [ ] **Step 8: Update `todays-notes.tsx`**

Replace the inline `toLocaleTimeString` (line 175-178):

```typescript
import { formatTimeOfDay } from '@/lib/time-format'
import { useGeneralSettings } from '@/hooks/use-general-settings'

// Inside NoteItem component (or parent that passes down):
const { settings: { clockFormat } } = useGeneralSettings()

const time = formatTimeOfDay(new Date(note.created), clockFormat)
```

- [ ] **Step 9: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:node && pnpm typecheck:web`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/renderer/src/components/reminder/ apps/desktop/src/renderer/src/components/snooze/ apps/desktop/src/renderer/src/lib/inbox-utils.ts apps/desktop/src/renderer/src/components/inbox-detail/ apps/desktop/src/renderer/src/components/journal/todays-notes.tsx
git commit -m "feat(settings): wire reminder, snooze, inbox, and journal to clockFormat"
```

---

### Task 6: Wire task formatting utilities

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/task-utils/task-formatting.ts`
- Modify: `apps/desktop/src/renderer/src/components/tasks/task-row.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tasks/today-task-row.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tasks/parent-task-row.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tasks/interactive-due-date-badge.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tasks/date-picker-content.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tasks/drag-drop/task-row.tsx`

- [ ] **Step 1: Update `task-formatting.ts` — `formatTime`**

Add `clockFormat` parameter:

```typescript
import { formatTimeString } from '@/lib/time-format'
import type { ClockFormat } from '@/lib/time-format'

export const formatTime = (time: string, clockFormat: ClockFormat = '12h'): string => {
  return formatTimeString(time, clockFormat)
}
```

- [ ] **Step 2: Update all 6 task component callers**

Each file imports `formatTime` from `@/lib/task-utils`. Add `useGeneralSettings` and pass `clockFormat`:

Pattern for each file:
```typescript
import { useGeneralSettings } from '@/hooks/use-general-settings'

// Inside component:
const { settings: { clockFormat } } = useGeneralSettings()

// At every formatTime(time) call site, change to:
formatTime(time, clockFormat)
```

Files:
1. `task-row.tsx` — `import { formatTime } from '@/lib/task-utils'` already present
2. `today-task-row.tsx` — same
3. `parent-task-row.tsx` — same
4. `interactive-due-date-badge.tsx` — same
5. `date-picker-content.tsx` — same
6. `drag-drop/task-row.tsx` — same

- [ ] **Step 3: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:node && pnpm typecheck:web`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/task-utils/task-formatting.ts apps/desktop/src/renderer/src/components/tasks/
git commit -m "feat(settings): wire task time formatting to clockFormat"
```

---

### Task 7: Update existing tests

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/inbox-utils.test.ts`

- [ ] **Step 1: Update `formatTimestamp` tests in `inbox-utils.test.ts`**

The existing tests use `formatTimestamp(timestamp, period)`. Add coverage for the new `clockFormat` parameter:

```typescript
describe('formatTimestamp', () => {
  // Existing tests still pass (default is '12h')
  it('formats time as AM/PM for TODAY', () => {
    const timestamp = new Date(2026, 0, 1, 14, 30)
    const result = formatTimestamp(timestamp, 'TODAY')
    expect(result).toMatch(/2:30\s*PM/i)
  })

  it('formats time in 24h for TODAY', () => {
    const timestamp = new Date(2026, 0, 1, 14, 30)
    const result = formatTimestamp(timestamp, 'TODAY', '24h')
    expect(result).toMatch(/14:30/)
  })

  it('formats time in 24h for YESTERDAY', () => {
    const timestamp = new Date(2026, 0, 1, 9, 5)
    const result = formatTimestamp(timestamp, 'YESTERDAY', '24h')
    expect(result).toMatch(/09:05|9:05/)
  })

  // OLDER period is date-only — clockFormat should not affect it
  it('OLDER ignores clockFormat', () => {
    const timestamp = new Date(2026, 0, 1, 14, 30)
    const result12 = formatTimestamp(timestamp, 'OLDER', '12h')
    const result24 = formatTimestamp(timestamp, 'OLDER', '24h')
    expect(result12).toBe(result24)
  })
})
```

- [ ] **Step 2: Run all tests**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/lib/time-format.test.ts src/renderer/src/lib/inbox-utils.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/inbox-utils.test.ts
git commit -m "test(settings): update inbox-utils tests for clockFormat parameter"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full lint**

Run: `pnpm lint`
Expected: PASS

- [ ] **Step 2: Run full typecheck**

Run: `cd apps/desktop && pnpm typecheck:node && pnpm typecheck:web`
Expected: PASS (ignore pre-existing test file type errors)

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 4: Run IPC contract check**

Run: `pnpm ipc:check`
Expected: PASS (GeneralSettings type flows through contracts automatically)
