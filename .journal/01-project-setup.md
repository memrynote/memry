# 01 - Project Setup & Foundation

## Context

This is the first step in building the Journal feature for Memry. No journal code exists yet. We're starting from scratch with a clean foundation.

The Memry app already has:
- Electron + React 19 + TypeScript setup
- shadcn/ui components (New York style)
- Tailwind CSS 4
- Path aliases: `@/` and `@renderer/` → `src/renderer/src/`
- Package manager: pnpm

## Objective

Set up all dependencies, type definitions, folder structure, and utility functions needed for the journal feature. Create a minimal placeholder page to verify the setup works.

## Requirements

### 1. Install Dependencies

Install these packages via pnpm:

```bash
# Tiptap editor core and extensions
@tiptap/react
@tiptap/starter-kit
@tiptap/extension-placeholder
@tiptap/extension-link
@tiptap/extension-task-list
@tiptap/extension-task-item

# Date utilities
date-fns

# State management (if not already installed)
zustand
```

Verify installation by checking `package.json` for the new dependencies.

### 2. Create Folder Structure

Create these directories:

```
src/renderer/src/
├── pages/
│   └── JournalPage.tsx (placeholder for now)
├── components/
│   └── journal/
│       └── .gitkeep (we'll add components in later steps)
└── lib/
    ├── hooks/
    │   └── .gitkeep
    └── journal/
        ├── types.ts
        ├── storage.ts
        └── date-utils.ts
```

### 3. Define TypeScript Types

Create `src/renderer/src/lib/journal/types.ts` with these interfaces:

```typescript
/**
 * A single timestamped note entry within a journal day.
 * Multiple notes can exist per day.
 */
export interface JournalNote {
  id: string;
  timestamp: Date;
  content: string; // Tiptap HTML or JSON
  preview: string; // First 50 chars for list display
}

/**
 * A full journal entry for a single calendar day.
 */
export interface JournalEntry {
  id: string;
  date: string; // ISO 8601 date (YYYY-MM-DD)
  notes: JournalNote[];
  wordCount: number;
  createdAt: Date;
  lastModifiedAt: Date;
}

/**
 * User preferences for journal display.
 */
export interface JournalPreferences {
  density: 'compact' | 'balanced' | 'spacious';
  focusMode: boolean;
}

/**
 * Heat map data structure for calendar visualization.
 */
export interface HeatMapData {
  date: string; // YYYY-MM-DD
  noteCount: number;
  intensity: 0 | 1 | 2 | 3 | 4; // 0 = no notes, 4 = 11+ notes
}

/**
 * Day card visual state based on viewport position.
 */
export interface DayCardState {
  opacity: number; // 0.5 to 1.0
  scale: number; // 0.98 to 1.02
  isFocused: boolean; // True when in center of viewport
  isToday: boolean;
  isPast: boolean;
  isFuture: boolean;
}

/**
 * Density mode spacing configuration.
 */
export interface DensityConfig {
  cardGap: string;
  cardPadding: string;
  fontSize: string;
  editorHeight: string;
}
```

### 4. Create Storage Utilities

Create `src/renderer/src/lib/journal/storage.ts`:

```typescript
import { JournalEntry, JournalPreferences } from './types';

const STORAGE_PREFIX = 'journal';

/**
 * Get a journal entry for a specific date.
 */
export function getEntryByDate(date: string): JournalEntry | null {
  const key = `${STORAGE_PREFIX}:entry:${date}`;
  const data = localStorage.getItem(key);
  if (!data) return null;

  const parsed = JSON.parse(data);
  // Convert date strings back to Date objects
  return {
    ...parsed,
    createdAt: new Date(parsed.createdAt),
    lastModifiedAt: new Date(parsed.lastModifiedAt),
    notes: parsed.notes.map((note: any) => ({
      ...note,
      timestamp: new Date(note.timestamp)
    }))
  };
}

/**
 * Save a journal entry for a specific date.
 */
export function saveEntry(entry: JournalEntry): void {
  const key = `${STORAGE_PREFIX}:entry:${entry.date}`;
  localStorage.setItem(key, JSON.stringify(entry));
}

/**
 * Get all journal entry dates (for heat map calculation).
 */
export function getAllEntryDates(): string[] {
  const dates: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(`${STORAGE_PREFIX}:entry:`)) {
      const date = key.replace(`${STORAGE_PREFIX}:entry:`, '');
      dates.push(date);
    }
  }
  return dates.sort();
}

/**
 * Get user preferences.
 */
export function getPreferences(): JournalPreferences {
  const key = `${STORAGE_PREFIX}:preferences`;
  const data = localStorage.getItem(key);
  if (!data) {
    return {
      density: 'balanced',
      focusMode: false
    };
  }
  return JSON.parse(data);
}

/**
 * Save user preferences.
 */
export function savePreferences(prefs: JournalPreferences): void {
  const key = `${STORAGE_PREFIX}:preferences`;
  localStorage.setItem(key, JSON.stringify(prefs));
}

/**
 * Delete a journal entry by date.
 */
export function deleteEntry(date: string): void {
  const key = `${STORAGE_PREFIX}:entry:${date}`;
  localStorage.removeItem(key);
}
```

### 5. Create Date Utilities

Create `src/renderer/src/lib/journal/date-utils.ts`:

```typescript
import { format, isToday, isPast, isFuture, startOfDay, differenceInDays } from 'date-fns';

/**
 * Format a date for display in day card headers.
 */
export function formatDayCardDate(date: Date): string {
  if (isToday(date)) {
    return 'Today';
  }
  // Format as "Monday, January 15"
  return format(date, 'EEEE, MMMM d');
}

/**
 * Get ISO date string (YYYY-MM-DD) for storage keys.
 */
export function toISODate(date: Date): string {
  return format(startOfDay(date), 'yyyy-MM-dd');
}

/**
 * Determine if a date is today.
 */
export function checkIsToday(date: Date | string): boolean {
  const d = typeof date === 'string' ? new Date(date) : date;
  return isToday(d);
}

/**
 * Determine if a date is in the past.
 */
export function checkIsPast(date: Date | string): boolean {
  const d = typeof date === 'string' ? new Date(date) : date;
  return isPast(d) && !isToday(d);
}

/**
 * Determine if a date is in the future.
 */
export function checkIsFuture(date: Date | string): boolean {
  const d = typeof date === 'string' ? new Date(date) : date;
  return isFuture(d);
}

/**
 * Calculate days difference from today.
 */
export function daysFromToday(date: Date | string): number {
  const d = typeof date === 'string' ? new Date(date) : date;
  const today = startOfDay(new Date());
  return differenceInDays(d, today);
}

/**
 * Generate an array of dates for the timeline.
 * Returns dates from [today - daysBefore] to [today + daysAfter].
 */
export function generateTimelineDates(daysBefore: number, daysAfter: number): Date[] {
  const dates: Date[] = [];
  const today = startOfDay(new Date());

  for (let i = -daysBefore; i <= daysAfter; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    dates.push(date);
  }

  return dates;
}
```

### 6. Create Placeholder Journal Page

Create `src/renderer/src/pages/JournalPage.tsx`:

```typescript
import React from 'react';

export function JournalPage() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold">Journal</h1>
        <p className="mt-2 text-muted-foreground">
          Journal feature coming soon...
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          Setup complete. Ready for component implementation.
        </p>
      </div>
    </div>
  );
}
```

### 7. Add Route to Journal Page

Update the app's routing configuration to include the Journal page. The exact location depends on your routing setup, but typically this would be in:
- `src/renderer/src/App.tsx` (if using React Router)
- Or wherever routes are defined

Add a route like:
```typescript
<Route path="/journal" element={<JournalPage />} />
```

### 8. Verify Installation

Run these commands to verify everything works:

```bash
# Type check
pnpm typecheck

# Start dev server
pnpm dev
```

Navigate to the journal route and verify the placeholder page appears.

## Technical Constraints

- MUST use pnpm (not npm or yarn)
- MUST use path alias `@/` for imports from `src/renderer/src/`
- All date storage MUST use ISO 8601 format (YYYY-MM-DD)
- LocalStorage keys MUST use prefix `journal:` to avoid conflicts
- Type definitions MUST export interfaces, not types
- Date utilities MUST use `date-fns` library, not native Date methods

## Acceptance Criteria

- [ ] All dependencies installed in package.json
- [ ] Folder structure created with all specified directories
- [ ] `types.ts` exports all required interfaces
- [ ] `storage.ts` exports all CRUD functions for journal entries
- [ ] `date-utils.ts` exports all date formatting/comparison functions
- [ ] `JournalPage.tsx` renders placeholder content
- [ ] Journal route accessible in the app
- [ ] TypeScript compilation succeeds (no errors)
- [ ] Dev server starts without errors
- [ ] No console warnings about missing dependencies

## Example Import Patterns

After setup, imports should work like this:

```typescript
// Component imports
import { JournalPage } from '@/pages/JournalPage';
import { DayCard } from '@/components/journal/DayCard';

// Utility imports
import { getEntryByDate, saveEntry } from '@/lib/journal/storage';
import { formatDayCardDate, toISODate } from '@/lib/journal/date-utils';
import type { JournalEntry, DayCardState } from '@/lib/journal/types';
```

## Notes

- We're using localStorage for now. In the future, this could be replaced with Electron's native storage or a database.
- The `journal` folder in `lib/` is the single source of truth for all journal-specific utilities.
- Zustand will be used for state management in later prompts (e.g., scroll position, focus mode).

## Next Steps

After completing this setup, proceed to `02-day-card-component.md` to build the individual day card component.
