# 06 - Today's Notes List (Sidebar Widget)

## Context

We now have:
- Calendar heat map showing activity across months
- Rich text editor saving timestamped notes
- Multiple notes can exist per day (each with a timestamp)

Now we build **TodaysNotesList** - a sidebar widget that shows all notes created today, with timestamps. This helps users see when they added notes throughout the day and provides quick navigation within today's entry.

Think of this like Reflect's "Notes" panel or a mini-timeline just for today.

## Objective

Create a component that:
1. Lists all notes created today, sorted by timestamp
2. Shows timestamp for each note (e.g., "9:34 AM")
3. Displays a preview of each note (first 50 chars)
4. Allows clicking to scroll/focus that note in the editor
5. Shows an empty state when no notes exist for today

## Requirements

### Component File

Create `src/renderer/src/components/journal/TodaysNotesList.tsx`

### Props Interface

```typescript
interface TodaysNotesListProps {
  date?: Date; // Defaults to today
  onNoteClick?: (noteId: string) => void; // Optional: focus/scroll to note
  className?: string;
}
```

### Data Structure

Each day's entry can have multiple notes:

```typescript
interface JournalEntry {
  date: string;
  notes: JournalNote[]; // Array of timestamped notes
}

interface JournalNote {
  id: string;
  timestamp: Date;
  content: string; // HTML from Tiptap
  preview: string; // Plain text preview
}
```

### Note List Item Component

```typescript
interface NoteItemProps {
  note: JournalNote;
  onClick?: (noteId: string) => void;
}

function NoteItem({ note, onClick }: NoteItemProps) {
  const timeStr = format(note.timestamp, 'h:mm a'); // "9:34 AM"

  return (
    <button
      onClick={() => onClick?.(note.id)}
      className={cn(
        'group w-full rounded-md border border-transparent px-3 py-2 text-left transition-colors',
        'hover:border-border hover:bg-accent'
      )}
    >
      <div className="flex items-start gap-2">
        {/* Time badge */}
        <span className="mt-0.5 shrink-0 rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {timeStr}
        </span>

        {/* Preview */}
        <div className="flex-1 overflow-hidden">
          <p className="line-clamp-2 text-sm text-muted-foreground group-hover:text-foreground">
            {note.preview || stripHtml(note.content).slice(0, 50)}
          </p>
        </div>
      </div>
    </button>
  );
}

/**
 * Strip HTML tags from content for preview.
 */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}
```

### Empty State Component

```typescript
function EmptyNotesState() {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <div className="mb-2 rounded-full bg-muted p-3">
        <svg
          className="h-6 w-6 text-muted-foreground"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
      </div>
      <p className="text-sm font-medium text-muted-foreground">No notes yet today</p>
      <p className="mt-1 text-xs text-muted-foreground/70">Start writing to see your notes here</p>
    </div>
  );
}
```

### Main Component

```typescript
import React, { useMemo } from 'react';
import { format } from 'date-fns';
import { getEntryByDate } from '@/lib/journal/storage';
import { toISODate } from '@/lib/journal/date-utils';
import type { JournalNote } from '@/lib/journal/types';
import { cn } from '@/lib/utils';

export function TodaysNotesList({ date, onNoteClick, className }: TodaysNotesListProps) {
  const targetDate = date || new Date();
  const dateStr = toISODate(targetDate);

  const entry = useMemo(() => getEntryByDate(dateStr), [dateStr]);

  const notes = useMemo(() => {
    if (!entry || !entry.notes.length) return [];

    // Sort by timestamp (most recent first)
    return [...entry.notes].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }, [entry]);

  const isToday = toISODate(new Date()) === dateStr;

  return (
    <div className={cn('rounded-lg border border-border bg-card p-4', className)}>
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {isToday ? "Today's Notes" : format(targetDate, 'MMM d Notes')}
        </h3>
        {notes.length > 0 && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {notes.length}
          </span>
        )}
      </div>

      {/* Notes list or empty state */}
      {notes.length === 0 ? (
        <EmptyNotesState />
      ) : (
        <div className="space-y-1">
          {notes.map((note) => (
            <NoteItem key={note.id} note={note} onClick={onNoteClick} />
          ))}
        </div>
      )}

      {/* Footer with word count */}
      {entry && entry.wordCount > 0 && (
        <div className="mt-3 border-t pt-3 text-xs text-muted-foreground">
          {entry.wordCount} {entry.wordCount === 1 ? 'word' : 'words'} written
        </div>
      )}
    </div>
  );
}
```

### Auto-Update on New Notes

To make the list update when new notes are added, we need to trigger re-renders. Use a simple state update or event system.

Option 1: Polling (simple but less efficient)
```typescript
import { useState, useEffect } from 'react';

// Inside TodaysNotesList component
const [updateTrigger, setUpdateTrigger] = useState(0);

useEffect(() => {
  // Poll every 2 seconds for updates
  const interval = setInterval(() => {
    setUpdateTrigger((prev) => prev + 1);
  }, 2000);

  return () => clearInterval(interval);
}, []);
```

Option 2: Event-based (better)
Create `src/renderer/src/lib/journal/events.ts`:

```typescript
type JournalEventCallback = () => void;

const listeners: JournalEventCallback[] = [];

/**
 * Subscribe to journal entry updates.
 */
export function onJournalUpdate(callback: JournalEventCallback) {
  listeners.push(callback);
  return () => {
    const index = listeners.indexOf(callback);
    if (index > -1) listeners.splice(index, 1);
  };
}

/**
 * Notify all listeners that a journal entry was updated.
 */
export function notifyJournalUpdate() {
  listeners.forEach((callback) => callback());
}
```

Update `storage.ts` to emit events:
```typescript
import { notifyJournalUpdate } from './events';

export function saveEntry(entry: JournalEntry): void {
  const key = `${STORAGE_PREFIX}:entry:${entry.date}`;
  localStorage.setItem(key, JSON.stringify(entry));
  notifyJournalUpdate(); // Notify listeners
}
```

Update `TodaysNotesList` to listen:
```typescript
import { onJournalUpdate } from '@/lib/journal/events';

useEffect(() => {
  const unsubscribe = onJournalUpdate(() => {
    setUpdateTrigger((prev) => prev + 1);
  });

  return unsubscribe;
}, []);
```

## Technical Constraints

- MUST sort notes by timestamp (most recent first)
- MUST strip HTML tags for preview text
- MUST use `line-clamp-2` to limit preview to 2 lines
- Time format MUST be "h:mm a" (e.g., "9:34 AM")
- Empty state MUST show when no notes exist
- MUST update automatically when new notes are added
- Word count MUST be accurate (not including HTML tags)

## Acceptance Criteria

- [ ] Component renders without errors
- [ ] Shows list of notes sorted by timestamp (newest first)
- [ ] Each note shows time badge and preview text
- [ ] Preview truncates to 50 chars / 2 lines
- [ ] Empty state shows when no notes for the day
- [ ] Header shows "Today's Notes" for current day
- [ ] Header shows "Jan 15 Notes" for other days
- [ ] Note count badge appears in header
- [ ] Word count shows in footer
- [ ] Clicking a note calls `onNoteClick` with note ID
- [ ] List updates when new notes are saved
- [ ] Hover effect on note items
- [ ] Scrollable if many notes exist

## Visual Reference

```
┌────────────────────────────────┐
│ Today's Notes              [3] │
├────────────────────────────────┤
│                                │
│ ┌────────────────────────────┐ │
│ │ [9:34 AM] Had a great      │ │ ← Most recent
│ │           meeting today... │ │
│ └────────────────────────────┘ │
│                                │
│ ┌────────────────────────────┐ │
│ │ [2:15 PM] Ideas for new    │ │
│ │           project features │ │
│ └────────────────────────────┘ │
│                                │
│ ┌────────────────────────────┐ │
│ │ [5:47 PM] Quick reminder   │ │
│ │           to follow up...  │ │
│ └────────────────────────────┘ │
│                                │
├────────────────────────────────┤
│ 347 words written              │
└────────────────────────────────┘

Empty state:
┌────────────────────────────────┐
│ Today's Notes                  │
├────────────────────────────────┤
│                                │
│         ┌─────────┐            │
│         │  📄     │            │
│         └─────────┘            │
│                                │
│    No notes yet today          │
│  Start writing to see your     │
│       notes here               │
│                                │
└────────────────────────────────┘
```

## Interaction Flow

1. User writes in editor → Auto-save triggers
2. New note is saved with timestamp
3. TodaysNotesList receives update event
4. New note appears at top of list
5. User clicks note → (future) Scrolls to that section in editor

## Edge Cases to Handle

- Very long notes: Truncate preview to 50 chars
- No notes: Show empty state
- Many notes (20+): Make list scrollable with max-height
- Notes with only whitespace: Don't show in preview
- Notes with only HTML tags: Strip and show "Empty note"

## Styling Notes

```css
/* Custom scrollbar for notes list if needed */
.notes-list-container {
  max-height: 400px;
  overflow-y: auto;
}

.notes-list-container::-webkit-scrollbar {
  width: 6px;
}

.notes-list-container::-webkit-scrollbar-thumb {
  background: hsl(var(--muted));
  border-radius: 3px;
}
```

## Testing Instructions

1. Write a note in today's editor
2. Wait for auto-save (1.5s)
3. Check that note appears in sidebar
4. Add another note → Should appear at top
5. Click a note item → Should log note ID
6. Check empty state for a day with no notes

## Performance Considerations

- Use `useMemo` to avoid re-sorting notes on every render
- Debounce update events if needed
- Consider virtualizing list if 50+ notes (unlikely)

## Next Steps

After completing the notes list, proceed to `07-focus-mode.md` to implement the distraction-free writing toggle.
