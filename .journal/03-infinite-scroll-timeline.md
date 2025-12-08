# 03 - Infinite Scroll Timeline with Fade-to-Focus

## Context

We now have:
- Project setup complete with dependencies and utilities
- `DayCard` component that renders individual day entries with different visual states

Now we build the **JournalTimeline** component - the scrollable container that:
- Renders multiple DayCard components in a vertical list
- Calculates each card's opacity/scale based on viewport position
- Implements the "fade-to-focus" effect where the centered card is most prominent
- Handles infinite scrolling (loading more days on scroll)
- Provides smooth scroll-to-date functionality

## Objective

Create a scrollable timeline that makes "today" the focal point, with cards fading out as they move away from the center of the viewport. The timeline should feel infinite, loading past and future days as the user scrolls.

## Requirements

### Component File

Create `src/renderer/src/components/journal/JournalTimeline.tsx`

### Props Interface

```typescript
interface JournalTimelineProps {
  density: 'compact' | 'balanced' | 'spacious';
  focusMode: boolean;
  onDateChange?: (date: Date) => void; // Called when centered date changes
  className?: string;
}
```

### Fade-to-Focus Algorithm

Calculate opacity and scale based on distance from viewport center:

```typescript
/**
 * Calculate visual state for a day card based on its position in viewport.
 *
 * @param elementTop - Top position of card relative to viewport
 * @param elementHeight - Height of the card
 * @param viewportHeight - Height of the viewport
 * @returns DayCardState with opacity and scale
 */
function calculateDayCardState(
  elementTop: number,
  elementHeight: number,
  viewportHeight: number,
  date: Date
): DayCardState {
  const elementCenter = elementTop + elementHeight / 2;
  const viewportCenter = viewportHeight / 2;
  const distanceFromCenter = Math.abs(elementCenter - viewportCenter);
  const maxDistance = viewportHeight / 2;

  // Normalize distance (0 = center, 1 = edge of viewport)
  const normalizedDistance = Math.min(distanceFromCenter / maxDistance, 1);

  // Today is special: always 100% opacity, scale 1.02
  const isToday = checkIsToday(date);
  if (isToday) {
    return {
      opacity: 1.0,
      scale: 1.02,
      isFocused: normalizedDistance < 0.2,
      isToday: true,
      isPast: false,
      isFuture: false
    };
  }

  // Calculate opacity: 1.0 at center, 0.5 at edges
  const opacity = 1.0 - (normalizedDistance * 0.5);

  // Calculate scale: 1.0 at center, 0.98 at edges
  const scale = 1.0 - (normalizedDistance * 0.02);

  return {
    opacity: Math.max(opacity, 0.5),
    scale: Math.max(scale, 0.98),
    isFocused: normalizedDistance < 0.2,
    isToday: false,
    isPast: checkIsPast(date),
    isFuture: checkIsFuture(date)
  };
}
```

### Scroll State Management

Use a custom hook to track scroll position and calculate visible dates:

Create `src/renderer/src/lib/hooks/useScrollFade.ts`:

```typescript
import { useState, useEffect, useRef, RefObject } from 'react';
import type { DayCardState } from '@/lib/journal/types';
import { checkIsToday, checkIsPast, checkIsFuture } from '@/lib/journal/date-utils';

interface UseScrollFadeReturn {
  cardStates: Map<string, DayCardState>;
  scrollRef: RefObject<HTMLDivElement>;
  centerDate: Date | null;
}

export function useScrollFade(dates: Date[]): UseScrollFadeReturn {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cardStates, setCardStates] = useState<Map<string, DayCardState>>(new Map());
  const [centerDate, setCenterDate] = useState<Date | null>(null);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    function updateCardStates() {
      if (!container) return;

      const viewportHeight = container.clientHeight;
      const newStates = new Map<string, DayCardState>();
      let closestToCenter: { date: Date; distance: number } | null = null;

      // Get all day card elements
      const cards = container.querySelectorAll('[data-date]');

      cards.forEach((card) => {
        const dateStr = card.getAttribute('data-date');
        if (!dateStr) return;

        const date = new Date(dateStr);
        const rect = card.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        const elementTop = rect.top - containerRect.top;
        const elementHeight = rect.height;
        const elementCenter = elementTop + elementHeight / 2;
        const viewportCenter = viewportHeight / 2;
        const distanceFromCenter = Math.abs(elementCenter - viewportCenter);

        // Track closest card to center
        if (!closestToCenter || distanceFromCenter < closestToCenter.distance) {
          closestToCenter = { date, distance: distanceFromCenter };
        }

        const state = calculateDayCardState(elementTop, elementHeight, viewportHeight, date);
        newStates.set(dateStr, state);
      });

      setCardStates(newStates);
      if (closestToCenter) {
        setCenterDate(closestToCenter.date);
      }
    }

    // Update on scroll
    container.addEventListener('scroll', updateCardStates);
    // Update on resize
    window.addEventListener('resize', updateCardStates);
    // Initial update
    updateCardStates();

    return () => {
      container.removeEventListener('scroll', updateCardStates);
      window.removeEventListener('resize', updateCardStates);
    };
  }, [dates]);

  return { cardStates, scrollRef, centerDate };
}

function calculateDayCardState(
  elementTop: number,
  elementHeight: number,
  viewportHeight: number,
  date: Date
): DayCardState {
  const elementCenter = elementTop + elementHeight / 2;
  const viewportCenter = viewportHeight / 2;
  const distanceFromCenter = Math.abs(elementCenter - viewportCenter);
  const maxDistance = viewportHeight / 2;
  const normalizedDistance = Math.min(distanceFromCenter / maxDistance, 1);

  const isToday = checkIsToday(date);
  if (isToday) {
    return {
      opacity: 1.0,
      scale: 1.02,
      isFocused: normalizedDistance < 0.2,
      isToday: true,
      isPast: false,
      isFuture: false
    };
  }

  const opacity = 1.0 - (normalizedDistance * 0.5);
  const scale = 1.0 - (normalizedDistance * 0.02);

  return {
    opacity: Math.max(opacity, 0.5),
    scale: Math.max(scale, 0.98),
    isFocused: normalizedDistance < 0.2,
    isToday: false,
    isPast: checkIsPast(date),
    isFuture: checkIsFuture(date)
  };
}
```

### Infinite Scroll Logic

Dynamically load more dates when scrolling near top or bottom:

```typescript
const INITIAL_DAYS_BEFORE = 30; // Load 30 days of history initially
const INITIAL_DAYS_AFTER = 7;   // Load 7 days of future initially
const LOAD_MORE_THRESHOLD = 500; // Load more when within 500px of edge

function useInfiniteScroll(scrollRef: RefObject<HTMLDivElement>) {
  const [daysBefore, setDaysBefore] = useState(INITIAL_DAYS_BEFORE);
  const [daysAfter, setDaysAfter] = useState(INITIAL_DAYS_AFTER);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    function handleScroll() {
      if (!container) return;

      const { scrollTop, scrollHeight, clientHeight } = container;

      // Near top: load more past days
      if (scrollTop < LOAD_MORE_THRESHOLD) {
        setDaysBefore((prev) => prev + 30);
      }

      // Near bottom: load more future days
      if (scrollTop + clientHeight > scrollHeight - LOAD_MORE_THRESHOLD) {
        setDaysAfter((prev) => prev + 7);
      }
    }

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [scrollRef]);

  return { daysBefore, daysAfter };
}
```

### Scroll to Date Function

Smooth scroll to a specific date:

```typescript
function scrollToDate(date: Date, scrollRef: RefObject<HTMLDivElement>) {
  const container = scrollRef.current;
  if (!container) return;

  const dateStr = toISODate(date);
  const targetCard = container.querySelector(`[data-date="${dateStr}"]`);

  if (targetCard) {
    targetCard.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  }
}
```

### Component Implementation

```typescript
import React, { useEffect, useRef } from 'react';
import { DayCard } from './DayCard';
import { useScrollFade } from '@/lib/hooks/useScrollFade';
import { generateTimelineDates, toISODate } from '@/lib/journal/date-utils';
import { getEntryByDate } from '@/lib/journal/storage';
import { cn } from '@/lib/utils';

export function JournalTimeline({ density, focusMode, onDateChange, className }: JournalTimelineProps) {
  const { daysBefore, daysAfter } = useInfiniteScroll(scrollRef);
  const dates = generateTimelineDates(daysBefore, daysAfter);
  const { cardStates, scrollRef, centerDate } = useScrollFade(dates);
  const hasScrolledToToday = useRef(false);

  // Scroll to today on initial mount
  useEffect(() => {
    if (!hasScrolledToToday.current && scrollRef.current) {
      const today = new Date();
      scrollToDate(today, scrollRef);
      hasScrolledToToday.current = true;
    }
  }, []);

  // Notify parent of centered date changes
  useEffect(() => {
    if (centerDate) {
      onDateChange?.(centerDate);
    }
  }, [centerDate, onDateChange]);

  // Calculate spacing based on density
  const gapClass = {
    compact: 'space-y-4',
    balanced: 'space-y-6',
    spacious: 'space-y-10'
  }[density];

  return (
    <div
      ref={scrollRef}
      className={cn(
        'h-full overflow-y-auto overflow-x-hidden',
        'scrollbar-thin scrollbar-thumb-muted scrollbar-track-transparent',
        className
      )}
    >
      <div className={cn('mx-auto max-w-3xl px-4 py-8', gapClass)}>
        {dates.map((date) => {
          const dateStr = toISODate(date);
          const entry = getEntryByDate(dateStr);
          const state = cardStates.get(dateStr) || {
            opacity: 0.5,
            scale: 0.98,
            isFocused: false,
            isToday: false,
            isPast: false,
            isFuture: false
          };

          return (
            <div key={dateStr} data-date={dateStr}>
              <DayCard
                date={date}
                entry={entry || undefined}
                state={state}
                density={density}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Infinite scroll hook
function useInfiniteScroll(scrollRef: RefObject<HTMLDivElement>) {
  const [daysBefore, setDaysBefore] = useState(30);
  const [daysAfter, setDaysAfter] = useState(7);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    function handleScroll() {
      if (!container) return;
      const { scrollTop, scrollHeight, clientHeight } = container;

      if (scrollTop < 500) {
        setDaysBefore((prev) => prev + 30);
      }

      if (scrollTop + clientHeight > scrollHeight - 500) {
        setDaysAfter((prev) => prev + 7);
      }
    }

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [scrollRef]);

  return { daysBefore, daysAfter };
}

// Scroll to date utility
export function scrollToDate(date: Date, scrollRef: RefObject<HTMLDivElement>) {
  const container = scrollRef.current;
  if (!container) return;

  const dateStr = toISODate(date);
  const targetCard = container.querySelector(`[data-date="${dateStr}"]`);

  if (targetCard) {
    targetCard.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  }
}
```

## Technical Constraints

- MUST use `useScrollFade` hook for calculating card states
- MUST use `data-date` attribute on each card wrapper for scroll targeting
- MUST implement infinite scroll with threshold-based loading
- MUST auto-scroll to today on initial mount
- Scroll behavior MUST be smooth with `behavior: 'smooth'`
- MUST use `scrollbar-thin` Tailwind utilities for custom scrollbar
- DO NOT use external virtual scrolling libraries yet (keep it simple)

## Acceptance Criteria

- [ ] Timeline renders 30 past days and 7 future days initially
- [ ] Auto-scrolls to "today" on page load
- [ ] Cards fade out (opacity 0.5-1.0) based on distance from center
- [ ] Cards scale (0.98-1.02) based on distance from center
- [ ] Today's card is always at 100% opacity and scale 1.02
- [ ] Scrolling near top loads 30 more past days
- [ ] Scrolling near bottom loads 7 more future days
- [ ] `onDateChange` callback fires when centered date changes
- [ ] Smooth transitions (300ms) when opacity/scale change
- [ ] Custom scrollbar styling applied
- [ ] No layout shift when new days are loaded
- [ ] Density prop affects spacing between cards

## Visual Reference

```
Viewport Center Line (invisible)
        ↓
┌───────────────────────────────────┐
│  Tomorrow (50% opacity) ──────────│  ↑ Top of viewport
│                                   │
│  ┌─────────────────────────────┐  │
│  │ Today (100%, scale 1.02)    │  │  ← Centered, most prominent
│  └─────────────────────────────┘  │
│                                   │
│  Yesterday (75% opacity) ─────────│
│                                   │
│  2 Days Ago (60% opacity) ────────│  ↓ Bottom of viewport
└───────────────────────────────────┘

As user scrolls down:
- Yesterday moves toward center → opacity increases
- Today moves up → opacity decreases
- 2 Days Ago comes into focus → becomes new center
```

## Performance Considerations

- Use `data-date` attributes instead of refs for scroll targeting (simpler)
- Throttle scroll event handler if performance issues arise
- Consider `will-change: transform, opacity` for smooth animations
- Lazy load entries from storage (don't load all at once)

## Testing Instructions

Add to JournalPage:

```typescript
<JournalTimeline
  density="balanced"
  focusMode={false}
  onDateChange={(date) => console.log('Center date:', date)}
/>
```

Test:
1. Page loads with today centered
2. Scroll up → past days load, opacity increases for centered cards
3. Scroll down → future days load
4. Today card always has accent border and full opacity
5. Cards smoothly transition when scrolling

## Notes

- The infinite scroll is "fake" - it pre-generates dates rather than fetching from server
- We're using native scroll rather than virtual scrolling for simplicity
- If performance issues arise with 100+ days, we can add `@tanstack/react-virtual` later

## Next Steps

After completing this timeline, proceed to `04-tiptap-editor.md` to replace the textarea placeholder with a real rich text editor.
