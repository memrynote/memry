# Memry Journal — Calendar Heatmap

## Overview

Build the calendar component for the right sidebar. This is a full month calendar with GitHub-style heatmap coloring based on journal character count. Users can click any day to navigate, and today is highlighted distinctly.

## Calendar Placement
```
┌───────────────────────────────────────┐
│                                       │
│           RIGHT SIDEBAR               │
│                                       │
│   ┌───────────────────────────────┐   │
│   │                               │   │
│   │      📅 CALENDAR              │   │  ← This component
│   │         HEATMAP               │   │
│   │                               │   │
│   └───────────────────────────────┘   │
│                                       │
│   ┌───────────────────────────────┐   │
│   │      ⚡ AI Connections        │   │
│   └───────────────────────────────┘   │
│                                       │
│   ┌───────────────────────────────┐   │
│   │      📝 Today's Notes         │   │
│   └───────────────────────────────┘   │
│                                       │
└───────────────────────────────────────┘
```

## Calendar Layout
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   📅 December 2024                    ◀   ▶  [Today]│
│   ─────────────────────────────────────────────────│
│                                                     │
│       Mo    Tu    We    Th    Fr    Sa    Su       │
│                                                     │
│                                     ░░    ░░    1  │
│                                                 ·  │
│                                                     │
│       2     3     4     5     6     7     8        │
│       ·    ░░    ▒▒          ·    ▓▓              │
│                                                     │
│      [9]   10    11    12    13    14    15        │
│       ██                                           │
│                                                     │
│       16    17    18    19    20    21    22       │
│                                                     │
│                                                     │
│       23    24    25    26    27    28    29       │
│                                                     │
│                                                     │
│       30    31                                      │
│                                                     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Component Sections

### Header
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   📅 December 2024                    ◀   ▶  [Today]│
│                                                     │
└─────────────────────────────────────────────────────┘

Layout:
┌─────────────────────────────────────────────────────┐
│  [ICON] [MONTH YEAR]                 [◀] [▶] [TODAY]│
└─────────────────────────────────────────────────────┘

Elements:
- Calendar icon (📅 or custom icon)
- Month and Year text (December 2024)
- Previous month button (◀)
- Next month button (▶)
- Today button [Today] - navigates to current day

Spacing:
- Left side: Icon + Month/Year
- Right side: Navigation buttons
- Gap between nav buttons: 8px
```

### Weekday Headers
```
       Mo    Tu    We    Th    Fr    Sa    Su

Properties:
- Abbreviated day names
- Centered in each column
- Subtle color (secondary text)
- Font: Small, uppercase or normal case
- No interaction (static labels)
```

### Day Grid
```
┌──────┬──────┬──────┬──────┬──────┬──────┬──────┐
│      │      │      │      │      │  ░░  │  1   │
│      │      │      │      │      │      │  ·   │
├──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│  2   │  3   │  4   │  5   │  6   │  7   │  8   │
│  ·   │  ░░  │  ▒▒  │      │  ·   │  ▓▓  │      │
├──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│ [9]  │  10  │  11  │  12  │  13  │  14  │  15  │
│  ██  │      │      │      │      │      │      │
├──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│  16  │  17  │  18  │  19  │  20  │  21  │  22  │
│      │      │      │      │      │      │      │
├──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│  23  │  24  │  25  │  26  │  27  │  28  │  29  │
│      │      │      │      │      │      │      │
├──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│  30  │  31  │      │      │      │      │      │
│      │      │      │      │      │      │      │
└──────┴──────┴──────┴──────┴──────┴──────┴──────┘

Each cell:
┌──────┐
│  9   │  ← Day number
│  ██  │  ← Heatmap indicator (dot or square)
└──────┘
```

## Heatmap Logic (GitHub Style)

Based on **character count** written in journal that day:
```
Characters Written    │  Level  │  Color Intensity  │  Visual
──────────────────────┼─────────┼───────────────────┼─────────
0                     │  0      │  No indicator     │  (empty)
1 - 100               │  1      │  Lightest         │  ░░ or ·
101 - 500             │  2      │  Light            │  ▒▒
501 - 1000            │  3      │  Medium           │  ▓▓
1001+                 │  4      │  Darkest          │  ██
```

### Color Examples (Green Theme like GitHub)
```
Level 0:  No color         (transparent or background)
Level 1:  #9be9a8          (very light green)
Level 2:  #40c463          (light green)
Level 3:  #30a14e          (medium green)
Level 4:  #216e39          (dark green)
```

### Alternative Color Themes
```
Blue Theme:
Level 1:  #dbeafe
Level 2:  #93c5fd
Level 3:  #3b82f6
Level 4:  #1d4ed8

Purple Theme:
Level 1:  #e9d5ff
Level 2:  #c084fc
Level 3:  #9333ea
Level 4:  #6b21a8

Amber Theme:
Level 1:  #fef3c7
Level 2:  #fcd34d
Level 3:  #f59e0b
Level 4:  #b45309
```

### Heatmap Indicator Style Options

**Option A: Dot below number**
```
┌──────┐
│  9   │
│  ●   │  ← Colored dot
└──────┘
```

**Option B: Background color**
```
┌──────┐
│ ▓▓▓▓ │  ← Entire cell has background color
│ ▓ 9 ▓│
│ ▓▓▓▓ │
└──────┘
```

**Option C: Small square indicator**
```
┌──────┐
│  9   │
│  ■   │  ← Small colored square
└──────┘
```

**Recommendation:** Option A (Dot) or Option C (Square) - cleaner, doesn't affect day number readability.

## Day Cell States

### Normal Day (Not Today, Not Selected)
```
┌──────┐
│  15  │
│  ▓▓  │
└──────┘

Properties:
- Day number: Normal text color
- Heatmap: Colored indicator based on level
- Background: Transparent
- Hover: Subtle background highlight
- Cursor: Pointer
```

### Today
```
┌──────┐
│ [9]  │  ← Ring/circle around number
│  ██  │     OR different background
└──────┘

Properties:
- Day number: Bold or highlighted
- Visual indicator: Ring, circle, or distinct background
- Heatmap: Still shows activity level
- Should be immediately recognizable
```

### Selected Day (Currently Scrolled To)
```
┌──────┐
│ •15• │  ← Filled background or strong highlight
│  ▓▓  │
└──────┘

Properties:
- Background: Filled with accent color
- Day number: Contrasting color (white on dark bg)
- Heatmap: Still visible
- Syncs with scroll position in main area
```

### Today + Selected (Same Day)
```
┌──────┐
│⦿ 9 ⦿│  ← Combined styling
│  ██  │
└──────┘

Properties:
- Has both "today" indicator AND "selected" styling
- Most prominent cell in calendar
```

### Empty Day (Outside Current Month)
```
┌──────┐
│      │  ← No number shown
│      │     OR very faded number from adjacent month
└──────┘

Properties:
- Either empty or shows adjacent month's day (faded)
- No heatmap indicator
- May or may not be clickable
```

### Future Day (No Content Yet)
```
┌──────┐
│  20  │
│      │  ← No heatmap indicator (no content written)
└──────┘

Properties:
- Day number visible
- No heatmap (nothing written yet)
- Still clickable (can navigate to future days)
```

## Interactive States

### Hover State
```
Normal:                    Hovered:
┌──────┐                   ┌──────┐
│  15  │        →         │▒ 15 ▒│  ← Subtle background
│  ▓▓  │                   │▒ ▓▓ ▒│
└──────┘                   └──────┘

Properties:
- Background: Subtle highlight color
- Cursor: Pointer
- Optional: Slight scale (transform: scale(1.05))
- Transition: 150ms ease
```

### Active/Click State
```
┌──────┐
│▓ 15 ▓│  ← Darker background momentarily
│▓ ▓▓ ▓│
└──────┘

Properties:
- Background: Darker than hover
- Brief flash before scroll animation starts
```

### Tooltip on Hover (Optional)
```
                    ┌─────────────────────┐
                    │ December 15         │
┌──────┐           │ 847 characters      │
│  15  │  ────────▶│ 2 notes created     │
│  ▓▓  │           └─────────────────────┘
└──────┘

Tooltip content:
- Full date
- Character count
- Notes count (optional)
- Appears after 500ms hover delay
```

## Navigation Behavior

### Previous/Next Month Buttons
```
Click ◀ (Previous):
1. Calendar transitions to previous month
2. Animation: Slide right or fade
3. Duration: 200ms
4. Heatmap data loads for new month

Click ▶ (Next):
1. Calendar transitions to next month
2. Animation: Slide left or fade
3. Duration: 200ms
4. Heatmap data loads for new month
```

### Today Button
```
Click [Today]:
1. Calendar navigates to current month (if not already)
2. Main scroll area scrolls to today's card
3. Today becomes selected day
4. Smooth scroll animation in main area
```

### Day Click
```
Click on December 15:
1. Calendar marks December 15 as selected
2. Main scroll area smoothly scrolls to December 15
3. Day card becomes active (100% opacity)
4. If different month, calendar stays on clicked month
```

## Syncing with Main Scroll

Calendar should stay in sync with the main scroll area:
```
User scrolls in main area:
         │
         ▼
Detect which day is now active (centered)
         │
         ▼
Update calendar:
- Selected day follows scroll
- If month changes, calendar switches month
         │
         ▼
Visual update (no animation, instant)
```

### Month Change During Scroll
```
Scrolling from December 31 to January 1:

Calendar:                          Calendar:
┌──────────────────┐               ┌──────────────────┐
│ December 2024    │      →        │ January 2025     │
│                  │  (instant)    │                  │
│ ... 30  [31]     │               │ [1]  2   3  ...  │
└──────────────────┘               └──────────────────┘

Transition: Instant (no animation) to avoid lag
```

## Component Structure
```
CalendarHeatmap
├── CalendarHeader
│   ├── CalendarIcon
│   ├── MonthYearDisplay
│   ├── PrevMonthButton
│   ├── NextMonthButton
│   └── TodayButton
│
├── WeekdayHeaders
│   └── WeekdayLabel (×7)
│
└── DayGrid
    └── DayCell (×35 or ×42, depending on month)
        ├── DayNumber
        └── HeatmapIndicator
```

## Data Structure
```typescript
interface CalendarData {
  currentMonth: number;        // 0-11
  currentYear: number;         // 2024
  selectedDate: string;        // "2024-12-15"
  today: string;               // "2024-12-09"
  heatmapData: HeatmapEntry[];
}

interface HeatmapEntry {
  date: string;                // "2024-12-15"
  characterCount: number;      // 847
  level: 0 | 1 | 2 | 3 | 4;   // Computed from characterCount
}

// Helper function
function getHeatmapLevel(charCount: number): number {
  if (charCount === 0) return 0;
  if (charCount <= 100) return 1;
  if (charCount <= 500) return 2;
  if (charCount <= 1000) return 3;
  return 4;
}
```

## Calendar Grid Generation
```
For December 2024:

1. First day of month: December 1, 2024 (Sunday)
2. Day of week: 0 (Sunday) - but we start week on Monday
3. So December 1 falls on column 7 (Sunday)
4. Need 5 empty cells before (Mon-Sat of previous week)

Grid layout:
Row 1:  [  ] [  ] [  ] [  ] [  ] [  ] [ 1 ]
Row 2:  [ 2 ] [ 3 ] [ 4 ] [ 5 ] [ 6 ] [ 7 ] [ 8 ]
Row 3:  [ 9 ] [10 ] [11 ] [12 ] [13 ] [14 ] [15 ]
Row 4:  [16 ] [17 ] [18 ] [19 ] [20 ] [21 ] [22 ]
Row 5:  [23 ] [24 ] [25 ] [26 ] [27 ] [28 ] [29 ]
Row 6:  [30 ] [31 ] [  ] [  ] [  ] [  ] [  ]

Total cells: 42 (6 rows × 7 columns)
```

## Sizing Specifications
```
Calendar Container:
├── Width: 100% of sidebar
├── Padding: 16px
├── Background: Subtle card background
├── Border-radius: 12px
│
├── Header
│   ├── Height: 40px
│   ├── Font-size: 14px (month/year)
│   ├── Button size: 28px × 28px
│   └── Margin-bottom: 12px
│
├── Weekday Headers
│   ├── Height: 24px
│   ├── Font-size: 11px
│   └── Margin-bottom: 8px
│
└── Day Grid
    ├── Grid: 7 columns, auto rows
    ├── Cell size: ~40px × 40px (flexible)
    ├── Gap: 2px
    │
    └── Day Cell
        ├── Day number font-size: 13px
        ├── Heatmap dot size: 6px × 6px
        └── Gap between number and dot: 2px
```

## Accessibility
```
Keyboard Navigation:
- Tab: Focus calendar
- Arrow keys: Navigate between days
- Enter/Space: Select focused day
- Home: Go to first day of month
- End: Go to last day of month
- Page Up: Previous month
- Page Down: Next month

Screen Reader:
- Each day announces: "December 15, 847 characters written"
- Selected state: "December 15, selected"
- Today: "December 9, today"

ARIA Labels:
- Calendar: role="grid", aria-label="Calendar"
- Day cell: role="gridcell", aria-selected="true/false"
- Buttons: aria-label="Previous month", "Next month", "Go to today"
```

## Events to Emit
```
onDayClick(date: string)
  → Parent scrolls main area to this date

onMonthChange(month: number, year: number)
  → Parent may preload data for new month

onTodayClick()
  → Parent scrolls main area to today
```

## Events to Receive
```
onActiveDayChange(date: string)
  → Calendar updates selected day
  → Calendar navigates to month if different
```

## Detailed Layout with Measurements
```
┌─────────────────────────────────────────────────────┐
│ ↑ 16px padding                                      │
│                                                     │
│   📅 December 2024                    ◀   ▶  [Today]│
│   ├─ 14px font ─┤                    ├28px buttons─┤│
│                                                     │
│   ─────────────────── ← 12px margin ────────────────│
│                                                     │
│       Mo    Tu    We    Th    Fr    Sa    Su       │
│       ├─────── 11px font, secondary color ───────┤ │
│                                                     │
│   ─────────────────── ← 8px margin ─────────────────│
│                                                     │
│   ┌────┬────┬────┬────┬────┬────┬────┐             │
│   │    │    │    │    │    │    │ 1  │             │
│   │    │    │    │    │    │    │ ·  │  ← 40px     │
│   ├────┼────┼────┼────┼────┼────┼────┤    height   │
│   │ 2  │ 3  │ 4  │ 5  │ 6  │ 7  │ 8  │             │
│   │ ·  │░░  │▒▒  │    │ ·  │▓▓  │    │             │
│   ├────┼────┼────┼────┼────┼────┼────┤             │
│   │[9] │ 10 │ 11 │ 12 │ 13 │ 14 │ 15 │             │
│   │ ██ │    │    │    │    │    │    │             │
│   ├────┼────┼────┼────┼────┼────┼────┤             │
│   │ 16 │ 17 │ 18 │ 19 │ 20 │ 21 │ 22 │             │
│   │    │    │    │    │    │    │    │             │
│   ├────┼────┼────┼────┼────┼────┼────┤             │
│   │ 23 │ 24 │ 25 │ 26 │ 27 │ 28 │ 29 │             │
│   │    │    │    │    │    │    │    │             │
│   ├────┼────┼────┼────┼────┼────┼────┤             │
│   │ 30 │ 31 │    │    │    │    │    │             │
│   │    │    │    │    │    │    │    │             │
│   └────┴────┴────┴────┴────┴────┴────┘             │
│       ├─ 2px gap between cells ─┤                   │
│                                                     │
│ ↓ 16px padding                                      │
└─────────────────────────────────────────────────────┘
```

## Expected Output

After implementing this prompt:
1. Full month calendar displays correctly
2. Heatmap colors show based on character count
3. Today is clearly highlighted
4. Selected day (scroll position) is highlighted
5. Click on day scrolls main area
6. Month navigation works (prev/next/today)
7. Calendar syncs with main scroll position
8. Proper hover and focus states
9. Accessible with keyboard navigation

## Do Not Include Yet

- AI Connections section (Prompt 10)
- Today's Notes section (Prompt 12)
- Animations beyond basic transitions

Focus only on the calendar heatmap component./

Implementation Notes
TechniqueWhyCSS GridPerfect for calendar layout (7 columns)CSS custom propertiesEasy theming for heatmap colorsEvent delegationSingle click handler on gridMemoizationCache heatmap level calculationsIntersection with parentSync with scroll position
Expected Outcome
After implementing this prompt, you should have:

Working calendar with month navigation
GitHub-style heatmap based on character count
Visual distinction for today and selected day
Click-to-navigate functionality
Sync with main scroll area
Proper responsive sizing for sidebar