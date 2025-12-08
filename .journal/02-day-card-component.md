# 02 - Day Card Component

## Context

Foundation is now set up:
- Dependencies installed (Tiptap, date-fns, zustand)
- Types defined in `@/lib/journal/types.ts`
- Storage utilities in `@/lib/journal/storage.ts`
- Date utilities in `@/lib/journal/date-utils.ts`
- Placeholder JournalPage exists

Now we build the core visual unit: the **DayCard** component. This is what displays for each calendar day in the timeline.

## Objective

Create a `DayCard` component that:
1. Shows the date header with proper formatting
2. Adapts visual style based on state (today, past, future)
3. Supports opacity/scale transformations for fade-to-focus effect
4. Displays a preview of notes for past days
5. Shows placeholder for future days

This component will later be populated with the Tiptap editor, but for now we'll use a simple textarea placeholder.

## Requirements

### Component File

Create `src/renderer/src/components/journal/DayCard.tsx`

### Props Interface

```typescript
interface DayCardProps {
  date: Date;
  entry?: JournalEntry; // Undefined if no notes for this day
  state: DayCardState; // Visual state (opacity, scale, focus)
  density: 'compact' | 'balanced' | 'spacious';
  onContentChange?: (content: string) => void;
  className?: string;
}
```

### Visual States

The card should render differently based on the date:

#### Today's Card (100% opacity, scale 1.02x)
- Border: `border-2 border-primary` (accent color)
- Background: `bg-card`
- Shadow: `shadow-lg`
- Date header: `text-2xl font-bold`
- Full editor visible (placeholder textarea for now)

#### Yesterday's Card (75% opacity, scale 1.0x)
- Border: `border border-border`
- Background: `bg-card`
- Shadow: `shadow-md`
- Date header: `text-xl font-semibold text-muted-foreground`
- Collapsed view with note preview

#### Past Days (2-7 days ago, 60% opacity, scale 0.98x)
- Border: `border border-border/50`
- Background: `bg-card/90`
- Shadow: `shadow`
- Date header: `text-xl font-medium text-muted-foreground/70`
- Collapsed, click to expand

#### Future Days (50-70% opacity based on distance)
- Border: `border-2 border-dashed border-border/50`
- Background: `bg-muted/30`
- Date header: `text-xl font-medium text-muted-foreground/50`
- Placeholder text: "Future entry..."

### Density Configurations

Apply these spacing/sizing rules based on density prop:

```typescript
const DENSITY_CONFIG = {
  compact: {
    cardPadding: 'p-4',
    dateSize: 'text-xl',
    contentSize: 'text-sm',
    minHeight: 'min-h-[12rem]',
    gap: 'space-y-2'
  },
  balanced: {
    cardPadding: 'p-6',
    dateSize: 'text-2xl',
    contentSize: 'text-base',
    minHeight: 'min-h-[16rem]',
    gap: 'space-y-3'
  },
  spacious: {
    cardPadding: 'p-8',
    dateSize: 'text-3xl',
    contentSize: 'text-lg',
    minHeight: 'min-h-[20rem]',
    gap: 'space-y-4'
  }
};
```

### Fade-to-Focus Transform

Apply transform based on `state` prop:

```css
style={{
  opacity: state.opacity,
  transform: `scale(${state.scale})`,
  transition: 'opacity 300ms ease, transform 300ms ease'
}}
```

### Date Header Format

Use `formatDayCardDate` from date-utils:
- Today → "Today"
- Other days → "Monday, January 15"

Add secondary text showing relative time for past days:
- "Yesterday"
- "2 days ago"
- "Last week"

### Note Preview for Past Days

If the card is for a past day and has notes:
- Show first 100 characters of content
- Display note count: "3 notes" badge
- Show last modified timestamp
- Add "Click to expand" hint

### Placeholder for Future Days

If the card is for a future day:
- Show dotted border
- Center-aligned text: "Future entry..."
- Subtle icon (calendar or clock)
- Reduce opacity based on days in future

### Interactive States

- Hover: Increase opacity by 0.1, add subtle shadow
- Focus: Show focus ring (keyboard navigation)
- Click on past day: Expand to show full content (toggle)

## Component Structure

```tsx
import React, { useState } from 'react';
import { formatDayCardDate, checkIsToday, checkIsPast, checkIsFuture, daysFromToday } from '@/lib/journal/date-utils';
import type { JournalEntry, DayCardState } from '@/lib/journal/types';
import { cn } from '@/lib/utils';

export function DayCard({ date, entry, state, density, onContentChange, className }: DayCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const isToday = checkIsToday(date);
  const isPast = checkIsPast(date);
  const isFuture = checkIsFuture(date);
  const daysDiff = daysFromToday(date);

  const config = DENSITY_CONFIG[density];

  // Calculate relative time text
  const relativeTime = getRelativeTimeText(daysDiff);

  return (
    <div
      className={cn(
        'rounded-lg transition-all duration-300',
        config.cardPadding,
        config.minHeight,
        getCardBorderClass(isToday, isPast, isFuture),
        getCardBackgroundClass(isToday, isPast, isFuture),
        'hover:shadow-lg',
        className
      )}
      style={{
        opacity: state.opacity,
        transform: `scale(${state.scale})`,
      }}
    >
      {/* Date Header */}
      <div className={cn('flex items-center justify-between', config.gap)}>
        <div>
          <h2 className={cn(config.dateSize, isToday ? 'font-bold' : 'font-semibold text-muted-foreground')}>
            {formatDayCardDate(date)}
          </h2>
          {relativeTime && (
            <p className="text-sm text-muted-foreground">{relativeTime}</p>
          )}
        </div>

        {/* Note count badge for past days */}
        {isPast && entry && entry.notes.length > 0 && (
          <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium">
            {entry.notes.length} {entry.notes.length === 1 ? 'note' : 'notes'}
          </span>
        )}
      </div>

      {/* Content Area */}
      <div className={cn('mt-4', config.gap)}>
        {isToday && (
          // Today: Show full editor (placeholder textarea)
          <textarea
            placeholder="Start writing..."
            className={cn(
              'w-full resize-none rounded-md border border-input bg-background px-3 py-2',
              config.contentSize,
              'focus:outline-none focus:ring-2 focus:ring-ring'
            )}
            rows={8}
            defaultValue={entry?.notes[0]?.content || ''}
            onChange={(e) => onContentChange?.(e.target.value)}
          />
        )}

        {isPast && entry && entry.notes.length > 0 && (
          // Past: Show preview or expanded view
          <div>
            {isExpanded ? (
              <div className="prose prose-sm max-w-none">
                {/* Will be replaced with Tiptap read-only view later */}
                <div className={config.contentSize}>{entry.notes[0].content}</div>
              </div>
            ) : (
              <div
                className="cursor-pointer rounded-md bg-muted/50 p-4 hover:bg-muted"
                onClick={() => setIsExpanded(true)}
              >
                <p className={cn(config.contentSize, 'line-clamp-3 text-muted-foreground')}>
                  {entry.notes[0].preview || entry.notes[0].content.slice(0, 100)}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">Click to expand</p>
              </div>
            )}
          </div>
        )}

        {isPast && (!entry || entry.notes.length === 0) && (
          // Past with no notes
          <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border/50">
            <p className="text-sm text-muted-foreground">No entries for this day</p>
          </div>
        )}

        {isFuture && (
          // Future: Placeholder
          <div className="flex h-32 flex-col items-center justify-center rounded-md border-2 border-dashed border-border/30">
            <svg
              className="mb-2 h-8 w-8 text-muted-foreground/30"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <p className="text-sm text-muted-foreground/50">Future entry...</p>
          </div>
        )}
      </div>

      {/* Footer with timestamp for past days */}
      {isPast && entry && (
        <div className="mt-4 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Last modified: {format(entry.lastModifiedAt, 'MMM d, yyyy h:mm a')}
          </p>
        </div>
      )}
    </div>
  );
}

// Helper functions
function getCardBorderClass(isToday: boolean, isPast: boolean, isFuture: boolean): string {
  if (isToday) return 'border-2 border-primary';
  if (isFuture) return 'border-2 border-dashed border-border/50';
  return 'border border-border/50';
}

function getCardBackgroundClass(isToday: boolean, isPast: boolean, isFuture: boolean): string {
  if (isToday) return 'bg-card shadow-lg';
  if (isFuture) return 'bg-muted/30';
  return 'bg-card/90 shadow-md';
}

function getRelativeTimeText(daysDiff: number): string | null {
  if (daysDiff === 0) return null; // Today
  if (daysDiff === -1) return 'Yesterday';
  if (daysDiff === 1) return 'Tomorrow';
  if (daysDiff < -1 && daysDiff > -7) return `${Math.abs(daysDiff)} days ago`;
  if (daysDiff < -7) return 'Last week';
  if (daysDiff > 1 && daysDiff < 7) return `In ${daysDiff} days`;
  return null;
}
```

## Technical Constraints

- MUST use `cn()` utility from `@/lib/utils` for className merging
- MUST import date utilities from `@/lib/journal/date-utils`
- MUST import types from `@/lib/journal/types`
- DO NOT implement Tiptap editor yet (use textarea placeholder)
- DO NOT implement auto-save yet (that comes in prompt 04)
- Transitions MUST use `transition-all duration-300` for smooth effects

## Acceptance Criteria

- [ ] Component renders without TypeScript errors
- [ ] Today's card shows with accent border and 100% opacity
- [ ] Past cards show with lower opacity and note preview
- [ ] Future cards show with dotted border and placeholder
- [ ] Density prop changes padding, font sizes, and heights
- [ ] State prop (opacity, scale) applies transform correctly
- [ ] Date header shows "Today" for current day
- [ ] Relative time text shows for past/future days
- [ ] Note count badge appears for past days with notes
- [ ] Past cards can expand/collapse on click
- [ ] Hover effect increases opacity slightly
- [ ] All transitions are smooth (300ms)

## Visual Reference

```
┌─────────────────────────────────────────────┐
│ Tomorrow                        In 1 day    │  ← Future (dotted border)
│                                             │
│         ┌───────────────┐                   │
│         │   Calendar    │                   │
│         │     Icon      │                   │
│         └───────────────┘                   │
│         Future entry...                     │
└─────────────────────────────────────────────┘

╔═════════════════════════════════════════════╗
║ Today                                       ║  ← Today (accent border, scale 1.02)
║                                             ║
║ ┌─────────────────────────────────────────┐ ║
║ │ Start writing...                        │ ║
║ │                                         │ ║
║ │                                         │ ║
║ │                                         │ ║
║ └─────────────────────────────────────────┘ ║
╚═════════════════════════════════════════════╝

┌─────────────────────────────────────────────┐
│ Monday, January 14      Yesterday  [3 notes]│  ← Past (75% opacity)
│                                             │
│ ┌─────────────────────────────────────────┐ │
│ │ Had a great meeting today about the new│ │
│ │ project. Discussed timelines and...    │ │
│ │                                         │ │
│ │ Click to expand                         │ │
│ └─────────────────────────────────────────┘ │
│ Last modified: Jan 14, 2024 5:47 PM        │
└─────────────────────────────────────────────┘
```

## Testing Instructions

Create a test file or add to the JournalPage to verify:

```typescript
import { DayCard } from '@/components/journal/DayCard';

// Test with different states
<DayCard
  date={new Date()} // Today
  state={{ opacity: 1.0, scale: 1.02, isFocused: true, isToday: true, isPast: false, isFuture: false }}
  density="balanced"
/>

<DayCard
  date={new Date(Date.now() - 86400000)} // Yesterday
  state={{ opacity: 0.75, scale: 1.0, isFocused: false, isToday: false, isPast: true, isFuture: false }}
  density="balanced"
  entry={{
    id: '1',
    date: '2024-01-14',
    notes: [{
      id: '1',
      timestamp: new Date(),
      content: 'Had a great meeting today...',
      preview: 'Had a great meeting today...'
    }],
    wordCount: 50,
    createdAt: new Date(),
    lastModifiedAt: new Date()
  }}
/>
```

## Notes

- The textarea is temporary. It will be replaced with Tiptap editor in prompt 04.
- Expand/collapse functionality for past days is basic. We can enhance with animations later.
- The component is intentionally simple to keep it focused on visual states.

## Next Steps

After completing this component, proceed to `03-infinite-scroll-timeline.md` to build the timeline container that will hold multiple DayCard components with fade-to-focus effect.
