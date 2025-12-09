# Memry Journal — Day Card Structure

## Overview

Build the structure for individual day cards. Each day card contains a header, collapsible sections, notes list, and journal editor. This prompt focuses on the overall structure and layout. Detailed components come in later prompts.

## Day Card Anatomy
```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                                          ┃
┃   HEADER                                                                 ┃
┃   Date, Day Name, Weather                                                ┃
┃                                                                          ┃
┠──────────────────────────────────────────────────────────────────────────┨
┃                                                                          ┃
┃   SECTION 1: Calendar Events (Collapsible)                               ┃
┃                                                                          ┃
┠──────────────────────────────────────────────────────────────────────────┨
┃                                                                          ┃
┃   SECTION 2: Overdue Tasks (Collapsible)                                 ┃
┃                                                                          ┃
┠──────────────────────────────────────────────────────────────────────────┨
┃                                                                          ┃
┃   SECTION 3: Notes                                                       ┃
┃                                                                          ┃
┠──────────────────────────────────────────────────────────────────────────┨
┃                                                                          ┃
┃   SECTION 4: Journal Editor                                              ┃
┃                                                                          ┃
┃                                                                          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

## Detailed Layout
```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                                          ┃
┃   December 9                                                    ☀️ 18°C  ┃
┃   TUESDAY                                                                ┃
┃                                                                          ┃
┃━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┃
┃                                                                          ┃
┃   ┌──────────────────────────────────────────────────────────────────┐   ┃
┃   │  📆 Calendar Events                                  3 meetings ⌄│   ┃
┃   └──────────────────────────────────────────────────────────────────┘   ┃
┃                                                                          ┃
┃   ┌──────────────────────────────────────────────────────────────────┐   ┃
┃   │  ⏱️ Overdue Tasks                                       5 tasks ⌄│   ┃
┃   └──────────────────────────────────────────────────────────────────┘   ┃
┃                                                                          ┃
┃   ┌──────────────────────────────────────────────────────────────────┐   ┃
┃   │  📝 Notes                                                   (2)  │   ┃
┃   │  ────────────────────────────────────────────────────────────    │   ┃
┃   │                                                                  │   ┃
┃   │  9:34 AM    📄 Meeting Notes                                 →  │   ┃
┃   │  2:15 PM    📄 Feature Ideas                                 →  │   ┃
┃   │                                                                  │   ┃
┃   └──────────────────────────────────────────────────────────────────┘   ┃
┃                                                                          ┃
┃   ┌──────────────────────────────────────────────────────────────────┐   ┃
┃   │  ✍️ Journal                                                      │   ┃
┃   │  ────────────────────────────────────────────────────────────    │   ┃
┃   │                                                                  │   ┃
┃   │  ┌────────────────────────────────────────────────────────────┐  │   ┃
┃   │  │                                                            │  │   ┃
┃   │  │  Had a great meeting today. Sarah brought up some          │  │   ┃
┃   │  │  interesting points about [[onboarding]] that I hadn't     │  │   ┃
┃   │  │  considered before...                                      │  │   ┃
┃   │  │                                                            │  │   ┃
┃   │  │                                                            │  │   ┃
┃   │  ├────────────────────────────────────────────────────────────┤  │   ┃
┃   │  │  B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮  │  ◱               │  │   ┃
┃   │  └────────────────────────────────────────────────────────────┘  │   ┃
┃   │                                                                  │   ┃
┃   └──────────────────────────────────────────────────────────────────┘   ┃
┃                                                                          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

## Section 1: Header
```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   December 9                                                    ☀️ 18°C  │
│   TUESDAY                                                                │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

Layout:
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   [DATE]                                              [WEATHER ICON + °] │
│   [DAY NAME]                                                             │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

LEFT SIDE:
- Line 1: Full date (December 9, 2024 or December 9)
- Line 2: Day name in uppercase (TUESDAY)
- Font: Date is larger/bolder, day name is smaller/lighter

RIGHT SIDE:
- Weather icon (emoji or icon)
- Temperature
- Optional: Location

Spacing:
- Padding: 20px horizontal, 16px vertical
- Gap between date and day name: 4px
```

### Header Variations
```
TODAY:
┌──────────────────────────────────────────────────────────────────────────┐
│   December 9                                                    ☀️ 18°C  │
│   TUESDAY • Today                                                        │
└──────────────────────────────────────────────────────────────────────────┘
        └── "Today" badge or label

YESTERDAY:
┌──────────────────────────────────────────────────────────────────────────┐
│   December 8                                                    ☁️ 15°C  │
│   MONDAY • Yesterday                                                     │
└──────────────────────────────────────────────────────────────────────────┘

TOMORROW:
┌──────────────────────────────────────────────────────────────────────────┐
│   December 10                                                   🌤️ 16°C  │
│   WEDNESDAY • Tomorrow                                                   │
└──────────────────────────────────────────────────────────────────────────┘

OTHER DAYS:
┌──────────────────────────────────────────────────────────────────────────┐
│   December 5                                                    🌧️ 12°C  │
│   SATURDAY                                                               │
└──────────────────────────────────────────────────────────────────────────┘
        └── No special badge
```

## Section 2: Calendar Events (Collapsed by Default)
```
COLLAPSED STATE:
┌──────────────────────────────────────────────────────────────────────────┐
│  📆 Calendar Events                                      3 meetings  ⌄  │
└──────────────────────────────────────────────────────────────────────────┘
     │                                                          │       │
     │                                                          │       └── Chevron (down = collapsed)
     │                                                          └── Count badge
     └── Section icon + title

EXPANDED STATE:
┌──────────────────────────────────────────────────────────────────────────┐
│  📆 Calendar Events                                      3 meetings  ⌃  │
│  ────────────────────────────────────────────────────────────────────    │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  9:00 AM                                                           │  │
│  │  Team Standup                                         (5 people)   │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  2:00 PM                                                           │  │
│  │  Design Review                                        (3 people)   │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  4:30 PM                                                           │  │
│  │  1:1 with Sarah                                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

NO EVENTS:
Section does not render at all (hidden completely)
```

## Section 3: Overdue Tasks (Collapsed by Default)
```
COLLAPSED STATE:
┌──────────────────────────────────────────────────────────────────────────┐
│  ⏱️ Overdue Tasks                                          5 tasks  ⌄  │
└──────────────────────────────────────────────────────────────────────────┘

EXPANDED STATE:
┌──────────────────────────────────────────────────────────────────────────┐
│  ⏱️ Overdue Tasks                                          5 tasks  ⌃  │
│  ────────────────────────────────────────────────────────────────────    │
│                                                                          │
│  ☐ Review PRs                                                   Dec 8   │
│  ☐ Update documentation                                         Dec 8   │
│  ☐ Send invoice to client                                       Dec 6   │
│  ☐ Finalize budget proposal                                     Dec 5   │
│  ☐ Book flight tickets                                          Dec 3   │
│                                                                          │
│  ────────────────────────────────────────────────────────────────────    │
│  [+ Add task]                                                            │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

NO OVERDUE TASKS:
Section does not render at all (hidden completely)
```

## Section 4: Notes (Always Visible)
```
WITH NOTES:
┌──────────────────────────────────────────────────────────────────────────┐
│  📝 Notes                                                           (2)  │
│  ────────────────────────────────────────────────────────────────────    │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  9:34 AM                                                           │  │
│  │  📄 Meeting Notes                                              →  │  │
│  │     "Discussed the roadmap changes..."                             │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  2:15 PM                                                           │  │
│  │  📄 Feature Ideas                                              →  │  │
│  │     "New onboarding flow concept..."                               │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

Each note item:
┌────────────────────────────────────────────────────────────────────┐
│  [TIME]                                                            │
│  [ICON] [NOTE TITLE]                                          →   │
│     "[Preview snippet...]"                   (optional, 1 line)    │
└────────────────────────────────────────────────────────────────────┘

NO NOTES:
┌──────────────────────────────────────────────────────────────────────────┐
│  📝 Notes                                                                │
│  ────────────────────────────────────────────────────────────────────    │
│                                                                          │
│       No notes from this day                                             │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Section 5: Journal Editor (Always Visible)
```
WITH CONTENT:
┌──────────────────────────────────────────────────────────────────────────┐
│  ✍️ Journal                                                              │
│  ────────────────────────────────────────────────────────────────────    │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  Had a great meeting today. Sarah brought up some interesting     │  │
│  │  points about [[onboarding]] that I hadn't considered before.     │  │
│  │                                                                    │  │
│  │  Key takeaways:                                                    │  │
│  │  • Timeline needs adjustment                                       │  │
│  │  • User research pending                                           │  │
│  │                                                                    │  │
│  │  #work #meetings                                                   │  │
│  │                                                                    │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │  B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮  │  ◱                       │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

EMPTY STATE:
┌──────────────────────────────────────────────────────────────────────────┐
│  ✍️ Journal                                                              │
│  ────────────────────────────────────────────────────────────────────    │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  Start writing...                           (placeholder text)     │  │
│  │                                                                    │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │  B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮  │  ◱                       │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Day Card States by Time

### Active Day (Today or Scroll-focused)
```
╔══════════════════════════════════════════════════════════════════════════╗
║                                                                          ║
║   December 9                                                    ☀️ 18°C  ║
║   TUESDAY • Today                                                        ║
║                                                                          ║
║══════════════════════════════════════════════════════════════════════════║
║                                                                          ║
║   [All sections as described above]                                      ║
║                                                                          ║
╚══════════════════════════════════════════════════════════════════════════╝

Properties:
- Border: 2px solid, prominent color (brand color or highlight)
- Background: Card background color
- Opacity: 100%
- Shadow: Subtle elevation (optional)
- All content fully interactive
```

### Past Day (Solid Border)
```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   December 7                                                    ☁️ 14°C  │
│   SUNDAY                                                                 │
│                                                                          │
│──────────────────────────────────────────────────────────────────────────│
│                                                                          │
│   [All sections as described above]                                      │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

Properties:
- Border: 1px solid, subtle color
- Background: Same as active
- Opacity: 25% - 70% (based on distance from active)
- Content: Fully editable (past days can be edited)
```

### Future Day (Dashed Border)
```
┌┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐
┆                                                                          ┆
┆   December 11                                                   🌤️ 15°C  ┆
┆   THURSDAY                                                               ┆
┆                                                                          ┆
┆┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┆
┆                                                                          ┆
┆   [All sections - mostly empty for future days]                          ┆
┆                                                                          ┆
└┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘

Properties:
- Border: 1px DASHED, subtle color
- Background: Same as active
- Opacity: 25% - 70% (based on distance from active)
- Content: Editable (can write in future days)
- Calendar Events: May show scheduled events
- Overdue Tasks: Empty (no overdue for future)
- Notes: Usually empty
- Journal: Empty, ready to write
```

## Empty Day Card (Minimal)

When a day has no content at all:
```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   December 5                                                    🌧️ 12°C  │
│   SATURDAY                                                               │
│                                                                          │
│──────────────────────────────────────────────────────────────────────────│
│                                                                          │
│   ┌────────────────────────────────────────────────────────────────────┐ │
│   │  📝 Notes                                                          │ │
│   │  ──────────────────────────────────────────────────────────────    │ │
│   │       No notes from this day                                       │ │
│   └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│   ┌────────────────────────────────────────────────────────────────────┐ │
│   │  ✍️ Journal                                                        │ │
│   │  ──────────────────────────────────────────────────────────────    │ │
│   │  ┌──────────────────────────────────────────────────────────────┐  │ │
│   │  │  Start writing...                                            │  │ │
│   │  ├──────────────────────────────────────────────────────────────┤  │ │
│   │  │  B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮  │  ◱                 │  │ │
│   │  └──────────────────────────────────────────────────────────────┘  │ │
│   └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

Note:
- Calendar Events section: HIDDEN (no events)
- Overdue Tasks section: HIDDEN (no tasks)
- Notes section: Shows "No notes" message
- Journal section: Shows empty editor with placeholder
```

## Component Hierarchy
```
DayCard
├── props: { date, isActive, isPast, isFuture, opacity }
│
├── DayCardHeader
│   ├── DateDisplay (December 9)
│   ├── DayName (TUESDAY)
│   ├── SpecialBadge (Today/Yesterday/Tomorrow)
│   └── WeatherDisplay (☀️ 18°C)
│
├── CalendarEventsSection (if hasEvents)
│   ├── CollapsibleHeader
│   └── EventsList
│       └── EventItem (multiple)
│
├── OverdueTasksSection (if hasTasks)
│   ├── CollapsibleHeader
│   ├── TasksList
│   │   └── TaskItem (multiple)
│   └── AddTaskButton
│
├── NotesSection
│   ├── SectionHeader
│   ├── NotesList (if hasNotes)
│   │   └── NoteItem (multiple)
│   └── EmptyState (if no notes)
│
└── JournalSection
    ├── SectionHeader
    └── JournalEditor (Tiptap)
        ├── EditorContent
        └── EditorToolbar
```

## Spacing Specifications
```
Day Card:
├── Padding: 24px
├── Border radius: 12px
├── Border: 1px (past) or 2px (active)
│
├── Header
│   ├── Padding-bottom: 16px
│   └── Border-bottom: 1px separator
│
├── Sections Gap: 16px between sections
│
├── Section (each)
│   ├── Padding: 16px
│   ├── Background: subtle (optional)
│   ├── Border-radius: 8px
│   └── Internal gap: 12px
│
└── Editor
    ├── Min-height: 150px
    ├── Padding: 16px
    └── Toolbar height: 44px
```

## Data Structure
```typescript
interface DayCard {
  date: string;                    // "2024-12-09"
  dayOfWeek: string;               // "Tuesday"
  weather?: {
    icon: string;                  // "☀️"
    temperature: number;           // 18
    unit: "C" | "F";
  };
  calendarEvents: CalendarEvent[];
  overdueTasks: Task[];
  notes: Note[];
  journalContent: string;          // Rich text content (HTML/JSON)
}

interface CalendarEvent {
  id: string;
  time: string;                    // "9:00 AM"
  title: string;                   // "Team Standup"
  attendeeCount?: number;          // 5
}

interface Task {
  id: string;
  title: string;
  dueDate: string;
  completed: boolean;
}

interface Note {
  id: string;
  createdAt: string;               // "9:34 AM"
  title: string;
  preview?: string;                // First line or snippet
}
```

## Conditional Rendering Logic
```
RENDER CALENDAR EVENTS SECTION:
  if (calendarEvents.length > 0) → render collapsed section
  else → do not render section at all

RENDER OVERDUE TASKS SECTION:
  if (overdueTasks.length > 0) → render collapsed section
  else → do not render section at all

RENDER NOTES SECTION:
  always render
  if (notes.length > 0) → show note list
  else → show "No notes from this day" empty state

RENDER JOURNAL SECTION:
  always render
  if (journalContent) → show content in editor
  else → show empty editor with placeholder
```

## Interactions Summary

| Element | Action | Result |
|---------|--------|--------|
| Collapsed section header | Click | Toggle expand/collapse |
| Calendar event | Click | Create meeting note (future feature) |
| Task checkbox | Click | Mark complete, task fades out |
| Add task button | Click | Show inline task input |
| Note item | Click | Open note in split view panel |
| Journal editor | Focus | Ready to type |
| Simple Mode button (◱) | Click | Enter Simple Mode |

## Expected Output

After implementing this prompt:
1. Day card renders with proper header (date, day, weather)
2. Collapsible sections appear when they have content
3. Empty sections are hidden (calendar, tasks) or show empty state (notes)
4. Journal editor always visible
5. Different border styles for past (solid) vs future (dashed)
6. Opacity controlled by parent (from infinite scroll)
7. All sections have proper spacing and visual hierarchy

## Do Not Include Yet

- Collapsible animation (Prompt 05)
- Split view panel for notes (Prompt 06)
- Tiptap editor details (Prompt 07)
- Simple Mode functionality (Prompt 08)

Focus on structure and static layout first.

Implementation Notes
TechniqueWhyConditional renderingDon't show empty sectionsComponent compositionEach section is its own componentProps for stateisActive, isPast, isFuture control stylingCSS variablesEasy theming for borders, backgroundsSemantic HTMLProper heading levels, section tags
Expected Outcome
After implementing this prompt, you should have:

Complete day card structure with all sections
Header with date, day name, and weather
Placeholder collapsible sections
Notes list structure
Journal editor container
Different visual states based on past/present/future
Proper spacing and typography hierarchy