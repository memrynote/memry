# Memry Journal — Infinite Scroll

## Overview

Build the infinite scroll mechanism for the Journal page. Days stack vertically with the active day in focus (100% opacity) and other days fading based on their distance from the viewport center.

## Scroll Direction Logic
```
                ▲
                │
                │  SCROLL UP = GO TO PAST
                │
    ┌───────────────────────────────┐
    │      December 5 (past)        │  ← Older days above
    └───────────────────────────────┘
                │
    ┌───────────────────────────────┐
    │      December 6 (past)        │
    └───────────────────────────────┘
                │
    ┌───────────────────────────────┐
    │      December 7 (past)        │
    └───────────────────────────────┘
                │
    ╔═══════════════════════════════╗
    ║   December 9 (TODAY/ACTIVE)   ║  ← Active day (viewport center)
    ╚═══════════════════════════════╝
                │
    ┌┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐
    ┆      December 10 (future)     ┆  ← Future days below
    └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘
                │
    ┌┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐
    ┆      December 11 (future)     ┆
    └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘
                │
                │  SCROLL DOWN = GO TO FUTURE
                │
                ▼
```

## Day Order in DOM

Days are rendered in chronological order from top to bottom:
```
Container (scroll)
│
├── Day Card: December 1   ← Oldest at top
├── Day Card: December 2
├── Day Card: December 3
├── Day Card: December 4
├── Day Card: December 5
├── Day Card: December 6
├── Day Card: December 7
├── Day Card: December 8
├── Day Card: December 9   ← Today (initial scroll position)
├── Day Card: December 10  ← Tomorrow
├── Day Card: December 11
├── Day Card: December 12
└── Day Card: December 13  ← Newest at bottom
```

## Initial Load

When the page first loads:
```
1. Load days range:
   - Past: 14 days before today
   - Future: 7 days after today
   - Total: ~22 days initially loaded

2. Initial scroll position:
   - Scroll to TODAY automatically
   - Today's card should be centered in viewport
   - No scroll animation on initial load (instant)

3. Initial state:
   - Today = active (100% opacity)
   - Yesterday, tomorrow = slightly faded
   - Older/further days = more faded
```

## Active Day Detection

The "active" day is determined by which day card is closest to the viewport center:
```
┌─────────────────────────────────────────────────┐
│                 VIEWPORT                        │
│                                                 │
│    ┌─────────────────────────────────────┐     │
│    │  December 8                         │     │  ← 30% in viewport
│    └─────────────────────────────────────┘     │
│                                                 │
│ ─ ─ ─ ─ ─ ─ VIEWPORT CENTER ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│                                                 │
│    ╔═════════════════════════════════════╗     │
│    ║  December 9 (ACTIVE)                ║     │  ← Center of this card
│    ║                                     ║     │     closest to viewport center
│    ╚═════════════════════════════════════╝     │
│                                                 │
│    ┌┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐     │  ← 20% in viewport
│    ┆  December 10                        ┆     │
└────┴┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┴─────┘

Detection Logic:
1. Get viewport center Y position
2. For each visible day card, calculate card center Y position
3. Find card with minimum distance to viewport center
4. That card becomes "active"
```

## Opacity Calculation

Opacity is based on distance from the active day:
```
Position          │ Opacity │ Visual
──────────────────┼─────────┼─────────────────────────
Active Day        │  100%   │ Full color, sharp
1 day away        │   70%   │ Slightly faded
2 days away       │   50%   │ Noticeably faded
3 days away       │   35%   │ Quite faded
4+ days away      │   25%   │ Very faded (minimum)
```

### Opacity Formula
```
distance = |dayIndex - activeDayIndex|

if (distance === 0) {
  opacity = 1.0      // Active day
} else if (distance === 1) {
  opacity = 0.7      // Adjacent days
} else if (distance === 2) {
  opacity = 0.5
} else if (distance === 3) {
  opacity = 0.35
} else {
  opacity = 0.25     // Minimum opacity
}
```

### Alternative: Smooth Gradient

For smoother transitions based on actual pixel distance:
```
distanceFromCenter = |cardCenterY - viewportCenterY|
maxDistance = viewportHeight

// Normalize to 0-1 range
normalizedDistance = Math.min(distanceFromCenter / maxDistance, 1)

// Calculate opacity (1 at center, 0.25 at edges)
opacity = 1 - (normalizedDistance * 0.75)

// Clamp minimum
opacity = Math.max(opacity, 0.25)
```

## Visual States

### Past Day (Above Active)
```
┌─────────────────────────────────────────────────┐
│                                                 │
│  December 7, Sunday                        ☁️   │
│  ───────────────────────────────────────────   │
│                                                 │
│  [Content faded but visible]                   │
│                                                 │
└─────────────────────────────────────────────────┘

Properties:
- Opacity: 25% - 70% (based on distance)
- Border: solid, subtle color
- Background: normal
- Interaction: fully clickable and editable
- Cursor: pointer (indicates clickable)
```

### Active Day (Current Focus)
```
╔═════════════════════════════════════════════════╗
║                                                 ║
║  December 9, Tuesday                       ☀️   ║
║  ═══════════════════════════════════════════   ║
║                                                 ║
║  [Full content, fully interactive]             ║
║                                                 ║
╚═════════════════════════════════════════════════╝

Properties:
- Opacity: 100%
- Border: solid, prominent color (highlight)
- Background: slightly elevated (subtle shadow or bg change)
- Transform: none (or subtle scale: 1.0)
- Interaction: fully interactive
```

### Future Day (Below Active)
```
┌┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐
┆                                                 ┆
┆  December 10, Wednesday                    🌤️   ┆
┆  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄   ┆
┆                                                 ┆
┆  [Content faded, placeholder for future]       ┆
┆                                                 ┆
└┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘

Properties:
- Opacity: 25% - 70% (based on distance)
- Border: DASHED or DOTTED (key differentiator)
- Border color: subtle
- Background: normal
- Interaction: clickable, can write in future days
```

## Scroll Event Handling
```
On Scroll:
│
├── 1. Debounce/throttle (16ms for 60fps, or use requestAnimationFrame)
│
├── 2. Calculate viewport center
│      viewportCenter = scrollTop + (viewportHeight / 2)
│
├── 3. Find active day
│      For each day card:
│        cardCenter = card.offsetTop + (card.offsetHeight / 2)
│        distance = |cardCenter - viewportCenter|
│      Active = card with minimum distance
│
├── 4. Update opacities
│      For each day card:
│        Calculate opacity based on distance from active
│        Apply opacity (CSS transition for smooth change)
│
├── 5. Sync with calendar (sidebar)
│      Update calendar to highlight active day
│      If month changed, update calendar month view
│
└── 6. Load more days if needed (infinite scroll)
        If scrolled near top → load older days
        If scrolled near bottom → load newer days
```

## Infinite Loading

### Load More Past Days
```
Trigger: User scrolls within 500px of top

Action:
1. Load 14 more past days
2. Prepend to day list
3. Maintain scroll position (prevent jump)
   - Save current scroll position
   - Add new content
   - Restore scroll position + height of new content

Visual:
┌─────────────────────────────────────┐
│  Loading...  (spinner at top)       │
└─────────────────────────────────────┘
           │
           ▼
    [New days prepended]
```

### Load More Future Days
```
Trigger: User scrolls within 500px of bottom

Action:
1. Load 14 more future days
2. Append to day list
3. No scroll position adjustment needed

Visual:
           │
           ▼
┌─────────────────────────────────────┐
│  Loading...  (spinner at bottom)    │
└─────────────────────────────────────┘
```

## Programmatic Scroll (Calendar Click)

When user clicks a day in the calendar:
```
User clicks December 5 in calendar
           │
           ▼
1. Find December 5 card in DOM
           │
           ▼
2. Calculate scroll position to center it
   targetScroll = card.offsetTop - (viewportHeight / 2) + (cardHeight / 2)
           │
           ▼
3. Animate scroll
   - Use smooth scroll behavior
   - Duration: ~400ms
   - Easing: ease-out
           │
           ▼
4. Update active state
   - December 5 becomes active (100% opacity)
   - Other days adjust accordingly
```

## Today Button Behavior
```
User clicks [Today] button in calendar header
           │
           ▼
1. Find today's card in DOM
           │
           ▼
2. Smooth scroll to center today
           │
           ▼
3. Today becomes active
           │
           ▼
4. Calendar highlights today
```

## Scroll Snap (Optional Enhancement)

For a more "page-like" feel:
```css
.scroll-container {
  scroll-snap-type: y proximity;  /* 'proximity' is gentler than 'mandatory' */
}

.day-card {
  scroll-snap-align: center;
}
```

This makes the scroll "snap" to center day cards when scroll momentum ends.

**Note:** This is optional. Some users prefer free scrolling. Consider making it a preference.

## Performance Optimization

### Virtualization (for very long date ranges)

If user scrolls far into past/future:
```
Only render day cards that are:
- Currently in viewport
- Within 5 cards above viewport
- Within 5 cards below viewport

Total rendered: ~11 cards maximum

As user scrolls:
- Add cards entering the buffer zone
- Remove cards leaving the buffer zone
- Use absolute positioning or transform for placement
```

### CSS Transitions for Opacity
```css
.day-card {
  transition: opacity 150ms ease-out;
}
```

This makes opacity changes smooth rather than jarring.

### Debounce Scroll Calculations
```
Use requestAnimationFrame for scroll handling
OR
Debounce to 16ms (60fps) maximum frequency
```

## State Management

Track the following state:
```
{
  // Loaded days
  days: [
    { date: '2024-12-01', content: {...} },
    { date: '2024-12-02', content: {...} },
    ...
  ],

  // Currently active day (center of viewport)
  activeDate: '2024-12-09',

  // Loading states
  isLoadingPast: false,
  isLoadingFuture: false,

  // Scroll boundaries
  oldestLoadedDate: '2024-11-25',
  newestLoadedDate: '2024-12-16',

  // Today's date (for reference)
  today: '2024-12-09'
}
```

## Day Card Height Considerations

Day cards have variable height based on content:
```
Empty day:        ~200px  (just header + empty editor)
Light content:    ~300px
Medium content:   ~450px
Heavy content:    ~600px+

This means:
- Cannot use fixed-height virtualization
- Must measure actual card heights
- Active day detection uses actual positions
```

## Accessibility
```
- Keyboard navigation: Arrow keys to move between days
- Focus management: Active day should be focusable
- Screen reader: Announce active day change
- Reduced motion: Respect prefers-reduced-motion
  - Disable smooth scroll
  - Disable opacity transitions
  - Use instant changes instead
```

## Events to Emit

The scroll component should emit these events for other components:
```
onActiveDayChange(date)     → Calendar highlights this date
onMonthChange(month, year)  → Calendar navigates to this month
onScrollNearEdge(edge)      → Trigger load more ('top' | 'bottom')
```

## Expected Output

After implementing this prompt:
1. Days render in chronological order (oldest top, newest bottom)
2. Scrolling works smoothly
3. Active day detection works based on viewport center
4. Opacity changes based on distance from active
5. Past days have solid borders
6. Future days have dashed/dotted borders
7. Infinite loading works in both directions
8. Calendar click triggers smooth scroll to day
9. Today button scrolls to current day

## Visual Summary
```
         ▲ SCROLL UP (past)
         │
    ░░░░░░░░░░░░░░░░░░░░░░░░░  25% opacity
    ░░░ December 5 ░░░░░░░░░░░  solid border
    ░░░░░░░░░░░░░░░░░░░░░░░░░
         │
    ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  50% opacity
    ▒▒▒ December 7 ▒▒▒▒▒▒▒▒▒▒▒  solid border
    ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
         │
    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  70% opacity
    ▓▓▓ December 8 ▓▓▓▓▓▓▓▓▓▓▓  solid border
    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
         │
    ███████████████████████████  100% opacity
    ███ December 9 (ACTIVE) ███  SOLID PROMINENT BORDER
    ███████████████████████████
         │
    ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓  70% opacity
    ▓ ▓ December 10 ▓ ▓ ▓ ▓ ▓ ▓  DASHED border
    ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓
         │
    ░ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░  25% opacity
    ░ ░ December 12 ░ ░ ░ ░ ░ ░  DASHED border
    ░ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░
         │
         ▼ SCROLL DOWN (future)
```


Implementation Notes
TechniqueWhyIntersection ObserverEfficient visibility detection for active dayrequestAnimationFrameSmooth, performant scroll handlingCSS transitionsSmooth opacity changesScroll position preservationPrevents jarring jumps when loading past daysDebounced state updatesPrevents excessive re-renders
Expected Outcome
After implementing this prompt, you should have:

Infinite scroll that loads more days in both directions
Active day detection based on viewport center
Opacity gradient based on distance from active
Visual distinction (solid vs dashed border) for past vs future
Smooth scroll when clicking calendar dates
Today button functionality
Performant scroll handling