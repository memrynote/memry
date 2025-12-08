# 11 - Empty States & First-Time Experience

## Context

We now have:
- Fully functional journal with timeline and editor
- Sidebar widgets showing calendar and notes
- Animations and polish

Now we implement **empty states** and **onboarding** to help new users understand the journal and guide them to their first entry. Empty states should be delightful, not frustrating.

## Objective

Create helpful, friendly empty states for:
1. First-time user (no journal entries exist)
2. Empty day (no notes for a specific day)
3. Empty sidebar (no notes today)
4. Empty calendar (no activity in visible months)
5. Optional: Quick tips or onboarding hints

## Requirements

### 1. First-Time User Empty State

Create `src/renderer/src/components/journal/EmptyJournalState.tsx`:

```typescript
import React from 'react';
import { Book, Calendar, Keyboard } from 'lucide-react';
import { cn } from '@/lib/utils';

export function EmptyJournalState({ className }: { className?: string }) {
  return (
    <div className={cn('flex min-h-screen items-center justify-center px-4', className)}>
      <div className="max-w-2xl text-center">
        {/* Hero illustration */}
        <div className="mb-8 flex justify-center">
          <div className="relative">
            <div className="absolute inset-0 animate-pulse rounded-full bg-primary/20 blur-2xl" />
            <Book className="relative h-20 w-20 text-primary" strokeWidth={1.5} />
          </div>
        </div>

        {/* Heading */}
        <h1 className="mb-4 text-4xl font-bold">Welcome to Your Journal</h1>
        <p className="mb-8 text-lg text-muted-foreground">
          A place to capture your thoughts, ideas, and memories—one day at a time.
        </p>

        {/* Feature highlights */}
        <div className="mb-8 grid gap-6 text-left sm:grid-cols-3">
          <FeatureCard
            icon={<Book className="h-6 w-6" />}
            title="Daily Entries"
            description="Write as much or as little as you want, each day"
          />
          <FeatureCard
            icon={<Calendar className="h-6 w-6" />}
            title="Activity Calendar"
            description="See your writing streak and navigate past entries"
          />
          <FeatureCard
            icon={<Keyboard className="h-6 w-6" />}
            title="Keyboard First"
            description="Navigate with shortcuts for a seamless experience"
          />
        </div>

        {/* Call to action */}
        <div className="space-y-3">
          <p className="text-sm font-medium text-muted-foreground">
            Start writing today, or jump to any date with{' '}
            <kbd className="kbd">⌘J</kbd>
          </p>
          <p className="text-xs text-muted-foreground">
            Press <kbd className="kbd">⌘/</kbd> anytime to see all shortcuts
          </p>
        </div>
      </div>
    </div>
  );
}

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent">
      <div className="mb-2 flex items-center gap-2 text-primary">
        {icon}
        <h3 className="font-semibold">{title}</h3>
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
```

### 2. Empty Day State (No Notes)

For days with no content, show an encouraging placeholder:

```typescript
// In DayCard.tsx, for past days with no notes
{isPast && (!entry || entry.notes.length === 0) && (
  <div className="flex flex-col items-center justify-center rounded-md border-2 border-dashed border-border/50 py-12">
    <div className="mb-3 rounded-full bg-muted p-3">
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
          d="M12 6v6m0 0v6m0-6h6m-6 0H6"
        />
      </svg>
    </div>
    <p className="text-sm font-medium text-muted-foreground">No entries for this day</p>
    <p className="mt-1 text-xs text-muted-foreground/70">
      Every blank page is a new opportunity
    </p>
  </div>
)}
```

### 3. Empty Sidebar - No Notes Today

Update `TodaysNotesList.tsx` to improve empty state:

```typescript
function EmptyNotesState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="mb-4 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 p-4">
        <svg
          className="h-8 w-8 text-primary"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
          />
        </svg>
      </div>
      <p className="text-sm font-semibold">No notes yet today</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Start writing to see your notes here
      </p>
    </div>
  );
}
```

### 4. Empty Calendar State (No Activity)

For new users with no entries, the calendar heat map should show helpful hints:

```typescript
// In CalendarHeatMap.tsx
function EmptyCalendarOverlay() {
  return (
    <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-card/90 backdrop-blur-sm">
      <div className="max-w-xs text-center">
        <Calendar className="mx-auto mb-3 h-12 w-12 text-muted-foreground/50" />
        <p className="text-sm font-medium text-muted-foreground">
          Your activity will appear here
        </p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          Write daily to build your streak
        </p>
      </div>
    </div>
  );
}

// In CalendarHeatMap component
const hasAnyActivity = useMemo(() => {
  return getAllEntryDates().length > 0;
}, []);

return (
  <div className="relative">
    {/* ... calendar grid ... */}
    {!hasAnyActivity && <EmptyCalendarOverlay />}
  </div>
);
```

### 5. Conditional Rendering in JournalPage

Update `JournalPage.tsx` to show empty state when no entries exist:

```typescript
import { EmptyJournalState } from '@/components/journal/EmptyJournalState';
import { getAllEntryDates } from '@/lib/journal/storage';

export function JournalPage() {
  const [hasEntries, setHasEntries] = useState(false);

  useEffect(() => {
    const entries = getAllEntryDates();
    setHasEntries(entries.length > 0);
  }, []);

  // Show empty state for new users
  if (!hasEntries) {
    return (
      <div className="h-full">
        <EmptyJournalState />
      </div>
    );
  }

  // Show normal journal UI
  return (
    <div className="flex h-full flex-col">
      {/* ... existing layout ... */}
    </div>
  );
}
```

### 6. Onboarding Tooltips (Optional)

For first-time users, show subtle hints on key features:

Create `src/renderer/src/components/journal/OnboardingTip.tsx`:

```typescript
import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface OnboardingTipProps {
  id: string; // Unique ID for localStorage persistence
  title: string;
  description: string;
  placement?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}

export function OnboardingTip({
  id,
  title,
  description,
  placement = 'bottom',
  className
}: OnboardingTipProps) {
  const [isDismissed, setIsDismissed] = useState(() => {
    return localStorage.getItem(`onboarding-tip-${id}`) === 'dismissed';
  });

  const handleDismiss = () => {
    localStorage.setItem(`onboarding-tip-${id}`, 'dismissed');
    setIsDismissed(true);
  };

  if (isDismissed) return null;

  return (
    <div
      className={cn(
        'absolute z-50 w-64 animate-in fade-in slide-in-from-top-2 rounded-lg border border-primary bg-card p-4 shadow-xl',
        placementClasses[placement],
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <h4 className="mb-1 text-sm font-semibold text-primary">{title}</h4>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <button
          onClick={handleDismiss}
          className="shrink-0 rounded p-1 hover:bg-accent"
          aria-label="Dismiss tip"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* Arrow */}
      <div
        className={cn(
          'absolute h-0 w-0 border-4 border-transparent',
          arrowClasses[placement]
        )}
      />
    </div>
  );
}

const placementClasses = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2'
};

const arrowClasses = {
  top: 'left-1/2 -translate-x-1/2 top-full border-t-card',
  right: 'right-full top-1/2 -translate-y-1/2 border-r-card',
  bottom: 'left-1/2 -translate-x-1/2 bottom-full border-b-card',
  left: 'left-full top-1/2 -translate-y-1/2 border-l-card'
};
```

Usage example:

```typescript
// In JournalPage.tsx, show tip on first visit
<div className="relative">
  <FocusModeToggle />
  <OnboardingTip
    id="focus-mode"
    title="Focus Mode"
    description="Hide the sidebar for distraction-free writing"
    placement="bottom"
  />
</div>
```

### 7. Empty Search Results (Future Feature)

Placeholder for when search feature is added:

```typescript
function EmptySearchState({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 rounded-full bg-muted p-4">
        <svg className="h-8 w-8 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>
      <h3 className="mb-2 text-lg font-semibold">No results found</h3>
      <p className="text-sm text-muted-foreground">
        No entries match "{query}"
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Try a different search term
      </p>
    </div>
  );
}
```

## Technical Constraints

- MUST check for entries before showing empty states
- Empty states MUST be dismissible where appropriate
- MUST persist dismissal in localStorage
- MUST show empty state only once per unique ID
- Empty states MUST be keyboard accessible
- Illustrations MUST use theme colors (work in light/dark mode)

## Acceptance Criteria

- [ ] First-time user sees welcome screen with feature highlights
- [ ] Empty day shows encouraging placeholder
- [ ] Empty notes list shows helpful message
- [ ] Empty calendar shows overlay hint
- [ ] All empty states are visually consistent
- [ ] Onboarding tips can be dismissed
- [ ] Dismissed tips don't reappear
- [ ] Empty states work in both light and dark mode
- [ ] All text is clear and friendly (not technical)
- [ ] Icons and illustrations are relevant
- [ ] Call-to-action is clear (e.g., "Start writing")

## Visual Reference

### First-Time User Screen

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│                        ___                              │
│                       |   |                             │
│                       |___|  (glowing book icon)        │
│                                                         │
│           Welcome to Your Journal                       │
│                                                         │
│    A place to capture your thoughts, ideas, and         │
│         memories—one day at a time.                     │
│                                                         │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐           │
│  │ Daily     │  │ Activity  │  │ Keyboard  │           │
│  │ Entries   │  │ Calendar  │  │ First     │           │
│  └───────────┘  └───────────┘  └───────────┘           │
│                                                         │
│     Start writing today, or jump to any date            │
│              with [⌘J]                                  │
│                                                         │
│     Press [⌘/] anytime to see all shortcuts             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Empty Day State

```
┌────────────────────────────────────┐
│ Monday, January 14      Yesterday  │
├────────────────────────────────────┤
│                                    │
│         ╔═══════════╗              │
│         ║     ┼     ║              │
│         ╚═══════════╝              │
│                                    │
│    No entries for this day         │
│    Every blank page is a new       │
│         opportunity                │
│                                    │
└────────────────────────────────────┘
```

## Copy Writing Guidelines

Empty states should be:
- **Friendly**: Use conversational tone
- **Encouraging**: Motivate action, don't make users feel bad
- **Clear**: Explain what to do next
- **Brief**: 1-2 sentences max

### Good Examples
✓ "No notes yet today. Start writing to see your notes here."
✓ "Every blank page is a new opportunity."
✓ "Your activity will appear here as you write."

### Bad Examples
✗ "No data available."
✗ "You haven't written anything."
✗ "Error: Empty state."

## Responsive Considerations

On mobile/narrow screens:
- Stack feature cards vertically
- Reduce icon sizes
- Shorten copy for readability
- Ensure touch targets are 44px minimum

## Testing Instructions

1. Clear all localStorage data
2. Open journal page → Should see welcome screen
3. Start writing → Welcome screen should disappear
4. Navigate to past day with no notes → Should see empty day state
5. Check sidebar notes list → Should show "No notes yet today"
6. Check calendar → Should show activity hint overlay
7. Dismiss onboarding tip → Should not reappear
8. Refresh page → Dismissed tips stay dismissed

## Performance Considerations

- Empty states should render instantly (no loading delay)
- Use SVG icons for crisp rendering at any size
- Lazy load onboarding tips (don't render until needed)

## Next Steps

After completing empty states, proceed to `12-integration-testing.md` for final integration and testing.
