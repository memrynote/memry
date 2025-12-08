# 05 - Calendar Heat Map Widget

## Context

We now have:
- Fully functional journal timeline with fade-to-focus
- Tiptap rich text editor with auto-save
- Storage system tracking entries by date

Now we build the **CalendarHeatMap** component - a visual calendar widget that shows activity density (like GitHub's contribution graph or Reflect's activity calendar). Each day is colored based on how many notes were written that day.

## Objective

Create a calendar widget that:
1. Shows a 3-month view (previous month, current month, next month)
2. Colors each day cell based on note count (heat map)
3. Highlights today with a distinct border
4. Shows tooltips with note count on hover
5. Navigates to a specific day when clicked (smooth scroll)

## Requirements

### Component File

Create `src/renderer/src/components/journal/CalendarHeatMap.tsx`

### Props Interface

```typescript
interface CalendarHeatMapProps {
  onDateClick: (date: Date) => void; // Navigate to this date in timeline
  className?: string;
}
```

### Heat Map Intensity Calculation

Calculate color intensity based on note count:

```typescript
/**
 * Convert note count to heat intensity level.
 */
function getHeatIntensity(noteCount: number): 0 | 1 | 2 | 3 | 4 {
  if (noteCount === 0) return 0; // No notes
  if (noteCount <= 2) return 1;  // 1-2 notes
  if (noteCount <= 5) return 2;  // 3-5 notes
  if (noteCount <= 10) return 3; // 6-10 notes
  return 4;                       // 11+ notes
}

/**
 * Get Tailwind class for heat intensity.
 */
function getHeatClass(intensity: 0 | 1 | 2 | 3 | 4): string {
  const classes = {
    0: 'bg-muted hover:bg-muted/80',           // No activity
    1: 'bg-primary/20 hover:bg-primary/30',    // Low activity
    2: 'bg-primary/40 hover:bg-primary/50',    // Medium activity
    3: 'bg-primary/60 hover:bg-primary/70',    // High activity
    4: 'bg-primary/80 hover:bg-primary/90'     // Very high activity
  };
  return classes[intensity];
}
```

### Generate Calendar Grid

Create helper to generate calendar data:

```typescript
import {
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  startOfWeek,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  addMonths,
  subMonths
} from 'date-fns';

interface CalendarDay {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  noteCount: number;
  intensity: 0 | 1 | 2 | 3 | 4;
}

interface CalendarMonth {
  name: string; // "January 2024"
  weeks: CalendarDay[][];
}

/**
 * Generate calendar data for 3 months (prev, current, next).
 */
function generateCalendarMonths(currentDate: Date): CalendarMonth[] {
  const prevMonth = subMonths(currentDate, 1);
  const nextMonth = addMonths(currentDate, 1);

  return [
    generateMonthData(prevMonth),
    generateMonthData(currentDate),
    generateMonthData(nextMonth)
  ];
}

function generateMonthData(date: Date): CalendarMonth {
  const monthStart = startOfMonth(date);
  const monthEnd = endOfMonth(date);
  const calendarStart = startOfWeek(monthStart, { weekStartsOn: 0 }); // Sunday
  const calendarEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });

  const days = eachDayOfInterval({ start: calendarStart, end: calendarEnd });

  // Group days into weeks
  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    const week = days.slice(i, i + 7).map((day) => {
      const dateStr = toISODate(day);
      const entry = getEntryByDate(dateStr);
      const noteCount = entry?.notes.length || 0;

      return {
        date: day,
        isCurrentMonth: isSameMonth(day, date),
        isToday: isToday(day),
        noteCount,
        intensity: getHeatIntensity(noteCount)
      };
    });
    weeks.push(week);
  }

  return {
    name: format(date, 'MMMM yyyy'),
    weeks
  };
}
```

### Calendar Cell Component

```typescript
interface CalendarCellProps {
  day: CalendarDay;
  onClick: (date: Date) => void;
}

function CalendarCell({ day, onClick }: CalendarCellProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div
      className="relative flex items-center justify-center"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <button
        onClick={() => onClick(day.date)}
        className={cn(
          'h-8 w-8 rounded text-xs font-medium transition-all',
          getHeatClass(day.intensity),
          day.isToday && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
          !day.isCurrentMonth && 'opacity-30',
          'hover:scale-110 active:scale-95'
        )}
        title={`${format(day.date, 'MMM d, yyyy')} - ${day.noteCount} notes`}
      >
        {format(day.date, 'd')}
      </button>

      {/* Tooltip */}
      {showTooltip && (
        <div className="absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-lg">
          <div className="font-medium">{format(day.date, 'MMM d, yyyy')}</div>
          <div className="text-muted-foreground">
            {day.noteCount === 0 ? 'No notes' : `${day.noteCount} ${day.noteCount === 1 ? 'note' : 'notes'}`}
          </div>
          {/* Arrow */}
          <div className="absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 border-4 border-transparent border-t-popover" />
        </div>
      )}
    </div>
  );
}
```

### Main Calendar Component

```typescript
import React, { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react'; // Or use custom SVG icons
import { cn } from '@/lib/utils';

export function CalendarHeatMap({ onDateClick, className }: CalendarHeatMapProps) {
  const [currentDate, setCurrentDate] = useState(new Date());

  const months = useMemo(() => generateCalendarMonths(currentDate), [currentDate]);

  const handlePrevMonth = () => {
    setCurrentDate((prev) => subMonths(prev, 1));
  };

  const handleNextMonth = () => {
    setCurrentDate((prev) => addMonths(prev, 1));
  };

  const handleDateClick = (date: Date) => {
    onDateClick(date);
  };

  return (
    <div className={cn('rounded-lg border border-border bg-card p-4', className)}>
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Activity Calendar</h3>
        <div className="flex gap-1">
          <button
            onClick={handlePrevMonth}
            className="rounded p-1 hover:bg-accent"
            title="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={handleNextMonth}
            className="rounded p-1 hover:bg-accent"
            title="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Weekday headers */}
      <div className="mb-2 grid grid-cols-7 gap-1">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => (
          <div key={day} className="text-center text-xs font-medium text-muted-foreground">
            {day}
          </div>
        ))}
      </div>

      {/* Months */}
      <div className="space-y-6">
        {months.map((month, monthIdx) => (
          <div key={`${month.name}-${monthIdx}`}>
            <div className="mb-2 text-xs font-medium text-muted-foreground">{month.name}</div>
            <div className="space-y-1">
              {month.weeks.map((week, weekIdx) => (
                <div key={`week-${weekIdx}`} className="grid grid-cols-7 gap-1">
                  {week.map((day, dayIdx) => (
                    <CalendarCell
                      key={`day-${weekIdx}-${dayIdx}`}
                      day={day}
                      onClick={handleDateClick}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="mt-4 flex items-center justify-end gap-2 text-xs text-muted-foreground">
        <span>Less</span>
        <div className="flex gap-1">
          <div className="h-3 w-3 rounded bg-muted" />
          <div className="h-3 w-3 rounded bg-primary/20" />
          <div className="h-3 w-3 rounded bg-primary/40" />
          <div className="h-3 w-3 rounded bg-primary/60" />
          <div className="h-3 w-3 rounded bg-primary/80" />
        </div>
        <span>More</span>
      </div>
    </div>
  );
}
```

## Technical Constraints

- MUST use `date-fns` for all date calculations
- MUST show exactly 3 months (prev, current, next)
- Week MUST start on Sunday (configurable in `startOfWeek`)
- Today MUST have ring border, not just background color
- Tooltip MUST show on hover with note count
- Click animation MUST use scale transform
- Calendar MUST re-fetch data when month changes

## Acceptance Criteria

- [ ] Calendar shows 3 months (previous, current, next)
- [ ] Each day cell is colored based on note count
- [ ] 5 intensity levels: 0 (no notes) to 4 (11+ notes)
- [ ] Today has a ring border around it
- [ ] Days outside current month are faded (30% opacity)
- [ ] Hover shows tooltip with date and note count
- [ ] Click on date scrolls to that day in timeline
- [ ] Navigation arrows cycle through months
- [ ] Legend shows color intensity scale
- [ ] Weekday headers (Su, Mo, Tu, etc.) are visible
- [ ] Month names are displayed above each month
- [ ] Click animation: scale(0.95) → scale(1.1) on hover

## Visual Reference

```
┌──────────────────────────────────────────┐
│ Activity Calendar           [<] [>]      │
├──────────────────────────────────────────┤
│ Su Mo Tu We Th Fr Sa                     │
│                                          │
│ December 2023                            │
│ □  □  □  □  □  1  2   (faded)            │
│ 3  4  5  6  7  8  9                      │
│ 10 ■  ■  13 ■  ■  16  (■ = has notes)    │
│ 17 ■  19 20 21 22 23                     │
│ 24 25 26 27 28 29 30                     │
│ 31                                       │
│                                          │
│ January 2024                             │
│    1  2  3  4  5  6                      │
│ 7  8  9  10 11 12 13                     │
│ 14 ■  ■  ■  ■  ■  20  (higher opacity)   │
│ 21 22 23 24 25 26 27                     │
│ 28 29 30 31                              │
│                                          │
│ February 2024                            │
│             1  2  3                      │
│ 4  5  6  7  8  9  10                     │
│ 11 12 13 14 [15] 16 17  ([15] = today)   │
│ 18 19 20 21 22 23 24                     │
│ 25 26 27 28 29                           │
│                                          │
│ Less □ ░ ▒ ▓ █ More                     │
└──────────────────────────────────────────┘
```

## Interaction Flow

1. User hovers over a day → Tooltip appears
2. User clicks a day → Timeline smoothly scrolls to that day (800ms)
3. User clicks prev/next arrows → Calendar shifts months
4. Today is always visually distinct with ring border

## Performance Considerations

- Memoize `generateCalendarMonths` to avoid recalculating on every render
- Use `useMemo` for months data
- Tooltip should use CSS positioning, not a portal (simpler)
- Consider caching entry data to avoid repeated localStorage reads

## Integration with Timeline

Update `JournalPage.tsx` to connect the calendar with the timeline:

```typescript
import { CalendarHeatMap } from '@/components/journal/CalendarHeatMap';
import { scrollToDate } from '@/components/journal/JournalTimeline';

function JournalPage() {
  const timelineRef = useRef<{ scrollToDate: (date: Date) => void }>(null);

  const handleDateClick = (date: Date) => {
    timelineRef.current?.scrollToDate(date);
  };

  return (
    <div className="grid grid-cols-[1fr_300px] gap-4">
      <JournalTimeline ref={timelineRef} />
      <aside>
        <CalendarHeatMap onDateClick={handleDateClick} />
      </aside>
    </div>
  );
}
```

## Optional Enhancements (Not Required)

- Keyboard navigation within calendar (arrow keys)
- Show current month name in header
- Animate month transitions when clicking arrows
- Add "Jump to Today" button below calendar

## Next Steps

After completing the calendar heat map, proceed to `06-sidebar-notes-list.md` to build the "Today's Notes" list component.
