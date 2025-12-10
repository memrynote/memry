# Memry Journal — Focus Mode

## Overview

Build Focus Mode, a distraction-free writing experience that hides the sidebar and all sections except the journal editor. Users can still scroll between days, but the interface is stripped down to essentials. This serves both casual users who want simplicity and deep writers who need focus.

## Mode Comparison
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   FULL MODE (Default)                    FOCUS MODE                         │
│                                                                             │
│   - Sidebar visible                      - Sidebar hidden                   │
│   - All sections visible                 - Only Journal Editor              │
│   - Multiple days, full cards            - Multiple days, minimal cards     │
│   - All features accessible              - Writing-focused                  │
│                                                                             │
│   Toggle: ◱ button in toolbar                                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Visual Comparison

### Full Mode (Default)
```
┌────────────┬─────────────────────────────────────────────┬──────────────────────┐
│            │                                             │                      │
│    NAV     │              JOURNAL AREA                   │    RIGHT SIDEBAR     │
│  SIDEBAR   │                                             │                      │
│            │  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │  ┌────────────────┐  │
│            │  ┃  December 9, 2025                     ┃  │  │ Calendar       │  │
│            │  ┃  ─────────────────────────────────    ┃  │  │ Heatmap        │  │
│            │  ┃  📆 Calendar Events         3  ⌄     ┃  │  └────────────────┘  │
│            │  ┃  ⏱️ Overdue Tasks           5  ⌄     ┃  │                      │
│            │  ┃  📝 Notes                  (2)       ┃  │  ┌────────────────┐  │
│            │  ┃  ✏️ Journal                          ┃  │  │ AI Connections │  │
│            │  ┃  [Editor...]                         ┃  │  └────────────────┘  │
│            │  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │                      │
│            │                                             │  ┌────────────────┐  │
│            │  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │  │ Today's Notes  │  │
│            │  ┃  December 10, 2025                    ┃  │  └────────────────┘  │
│            │  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │                      │
│            │                                             │                      │
└────────────┴─────────────────────────────────────────────┴──────────────────────┘
```

### Focus Mode
```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│                                                                                 │
│                                                                                 │
│                ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓            │
│                ┃                                                   ┃            │
│                ┃  Monday, December 8, 2025                         ┃ ← Past     │
│                ┃  ───────────────────────────────────────────────  ┃   (faded)  │
│                ┃  [Journal Editor only]                            ┃            │
│                ┃                                                   ┃            │
│                ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛            │
│                                                                                 │
│                ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓            │
│                ┃                                                   ┃            │
│                ┃  Tuesday, December 9, 2025                    ◱   ┃ ← Active   │
│                ┃  ───────────────────────────────────────────────  ┃   (100%)   │
│                ┃                                                   ┃            │
│                ┃  Today was productive. Had a great meeting        ┃            │
│                ┃  with the team about [[Project Alpha]].           ┃            │
│                ┃                                                   ┃            │
│                ┃  Key takeaways:                                   ┃            │
│                ┃  • Deadline moved to Q2                           ┃            │
│                ┃  • Need to hire 2 more engineers                  ┃            │
│                ┃                                                   ┃            │
│                ┃  #work #planning                                  ┃            │
│                ┃                                                   ┃            │
│                ┃  ───────────────────────────────────────────────  ┃            │
│                ┃  B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮  │  ◱       ┃            │
│                ┃                                                   ┃            │
│                ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛            │
│                                                                                 │
│                ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓            │
│                ┃                                                   ┃            │
│                ┃  Wednesday, December 10, 2025                     ┃ ← Future   │
│                ┃  ───────────────────────────────────────────────  ┃   (faded)  │
│                ┃  [Journal Editor only]                            ┃            │
│                ┃                                                   ┃            │
│                ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛            │
│                                                                                 │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## What Changes in Focus Mode

### Hidden Elements
```
HIDDEN:
├── Right Sidebar (entire)
│   ├── Calendar Heatmap
│   ├── AI Connections
│   └── Today's Notes
│
├── Collapsible Sections (within day card)
│   ├── 📆 Calendar Events
│   └── ⏱️ Overdue Tasks
│
├── Notes Section
│   └── 📝 Notes list
│
└── Section headers
    └── "✏️ Journal" label (unnecessary in Focus)

VISIBLE:
├── Minimal day header (date + toggle button)
├── Journal Editor (full focus)
├── Toolbar (with mode toggle)
└── Multiple days (scrollable, faded by distance)
```

### Layout Changes
```
Full Mode:
├── 3-column layout (Nav + Journal + Sidebar)
├── Day cards: Full width of journal area
├── All sections visible
└── Sidebar takes ~35% of remaining space

Focus Mode:
├── Full width (Nav hidden or minimized)
├── Day cards: Centered, max-width 700px
├── Only editor visible
└── No sidebar
```

## Focus Mode Day Card

### Structure
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                                                                             │
│            ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓          │
│            ┃                                                     ┃          │
│            ┃  Tuesday, December 9, 2025                      ◱   ┃          │
│            ┃                                                     ┃          │
│            ┃  ─────────────────────────────────────────────────  ┃          │
│            ┃                                                     ┃          │
│            ┃  ┌─────────────────────────────────────────────┐    ┃          │
│            ┃  │                                             │    ┃          │
│            ┃  │  Today was productive. Had a great          │    ┃          │
│            ┃  │  meeting with the team about                │    ┃          │
│            ┃  │  [[Project Alpha]]. We discussed the        │    ┃          │
│            ┃  │  new timeline and everyone seems            │    ┃          │
│            ┃  │  aligned.                                   │    ┃          │
│            ┃  │                                             │    ┃          │
│            ┃  │  Key takeaways:                             │    ┃          │
│            ┃  │  • Deadline moved to Q2                     │    ┃          │
│            ┃  │  • Need to hire 2 more engineers            │    ┃          │
│            ┃  │                                             │    ┃          │
│            ┃  │  #work #planning                            │    ┃          │
│            ┃  │                                             │    ┃          │
│            ┃  ├─────────────────────────────────────────────┤    ┃          │
│            ┃  │  B  I  U  S │ 🔗 📷 🎤 📎 │ ⋮ │ ◱          │    ┃          │
│            ┃  └─────────────────────────────────────────────┘    ┃          │
│            ┃                                                     ┃          │
│            ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛          │
│                                                                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Key differences from Full Mode:
- No section headers (no "✏️ Journal")
- No Calendar Events section
- No Overdue Tasks section
- No Notes section
- Simplified header (date + toggle only)
- Editor is the main content
- Max-width: 700px, centered
```

### Simplified Header
```
FULL MODE HEADER:
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   Monday                                        ☀️ 72°F        │
│   December 9, 2024                                             │
│                                                                │
└────────────────────────────────────────────────────────────────┘

FOCUS MODE HEADER:
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   Tuesday, December 9, 2025                                ◱   │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Changes:
- Single line date format (Day, Month Date, Year)
- Weather hidden
- Only toggle button visible
- Clean, minimal
```

## Toggle Button

### Button Design
```
FULL MODE (toggle visible in toolbar):
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮  │  ◱                                  │
│                                       └──┬──┘                                │
│                                          └── Focus Mode toggle               │
│                                              Tooltip: "Enter Focus Mode"     │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘


FOCUS MODE (toggle in header AND toolbar):
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   Tuesday, December 9, 2025                                ◱   │
│                                                            ↑   │
└────────────────────────────────────────────────────────────┴───┘
                                                             │
                                                       Also in header
                                                       for easy access
```

### Button States
```
FULL MODE (button inactive):
┌───┐
│ ◱ │  ← Normal appearance
└───┘
Tooltip: "Enter Focus Mode"


FOCUS MODE (button active):
┌───┐
│▓◱▓│  ← Highlighted/filled
└───┘
Tooltip: "Exit Focus Mode"


Click: Toggles between modes
```

### Icon Options
```
◱  - Square with corner (expand/simplify feel)
⛶  - Full screen arrows
◫  - Half-filled square
⊡  - Square with dot
▣  - Filled square with border

Recommendation: ◱ (simple, recognizable)
```

## Transition Animation

### Full Mode → Focus Mode
```
STEP 1: User clicks ◱ button
        │
        ▼
STEP 2: Right sidebar slides out

┌────────┬─────────────────────────────────────┬──────────────────┐
│        │                                     │                  │
│  NAV   │      JOURNAL                        │  SIDEBAR ───────▶│ (sliding out)
│        │                                     │                  │
└────────┴─────────────────────────────────────┴──────────────────┘
        │
        ▼
STEP 3: Nav sidebar collapses (or hides)

┌────────┬────────────────────────────────────────────────────────┐
│        │                                                        │
│NAV ───▶│      JOURNAL (expanding)                               │
│        │                                                        │
└────────┴────────────────────────────────────────────────────────┘
        │
        ▼
STEP 4: Sections fade out, day card centers

┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                                                                 │
│            ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓           │
│            ┃  December 9, 2025                  ◱   ┃           │
│            ┃  ───────────────────────────────────   ┃           │
│            ┃                                        ┃           │
│            ┃  [Journal Editor - centered]           ┃           │
│            ┃                                        ┃           │
│            ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Animation timing:
- Total duration: 300ms
- Sidebar slide out: 250ms ease-out
- Nav collapse: 200ms ease-out (starts at 50ms)
- Sections fade: 200ms (simultaneous)
- Card center: 300ms ease-out
```

### Focus Mode → Full Mode
```
STEP 1: User clicks ◱ or presses Escape
        │
        ▼
STEP 2: Day card expands, sections fade in

┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│            ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓           │
│            ┃  [Card expanding...]                   ┃           │
│            ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
STEP 3: Nav sidebar expands

┌────────┬────────────────────────────────────────────────────────┐
│        │                                                        │
│◀── NAV │      JOURNAL                                           │
│        │                                                        │
└────────┴────────────────────────────────────────────────────────┘
        │
        ▼
STEP 4: Right sidebar slides in

┌────────┬─────────────────────────────────────┬──────────────────┐
│        │                                     │                  │
│  NAV   │      JOURNAL                        │◀──── SIDEBAR     │
│        │                                     │                  │
└────────┴─────────────────────────────────────┴──────────────────┘

Animation timing:
- Total duration: 300ms
- Card expand: 200ms ease-out
- Nav expand: 200ms ease-out
- Sidebar slide in: 250ms ease-out (starts at 50ms)
- Sections fade in: 200ms (starts at 100ms)
```

## Scroll Behavior in Focus Mode

### Infinite Scroll Still Works
```
Focus Mode maintains infinite scroll:

                         ▲
                         │  Scroll up for past days
                         │
              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Sunday, December 7, 2025        ┃  ← Past (25% opacity)
              ┃  [Editor content...]             ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Monday, December 8, 2025        ┃  ← Past (50% opacity)
              ┃  [Editor content...]             ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Tuesday, December 9, 2025   ◱   ┃  ← Active (100% opacity)
              ┃  [Editor content...]             ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Wednesday, December 10, 2025    ┃  ← Future (50% opacity)
              ┃  [Editor content...]             ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                         │
                         │  Scroll down for future days
                         ▼

Same behavior as Full Mode:
- Opacity gradient based on distance from center
- Active day detection at viewport center
- Infinite loading at edges
- Past days: solid border
- Future days: dashed border
```

### Quick Navigation
```
"Today" floating button appears when scrolled away:

┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│            ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓              │
│            ┃  November 15, 2025                          ◱   ┃              │
│            ┃  [Past entry...]                                ┃              │
│            ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛              │
│                                                                             │
│                                                       ┌─────────┐          │
│                                                       │ [Today] │ ← Floating
│                                                       └─────────┘   button  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Click → Smooth scroll to today's card
```

## PKM Features Still Active
```
Wiki-links and tags work in Focus Mode:

┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Today I worked on [[Project Alpha]] with the team.             │
│                     └──────┬──────┘                             │
│                            └── Still clickable                  │
│                               Still shows autocomplete on [[    │
│                                                                 │
│  #work #planning #productivity                                  │
│  └─────────────┬─────────────┘                                  │
│                └── Still styled                                 │
│                    Still shows autocomplete on #                │
│                    Still clickable to filter                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Focus Mode hides visual complexity, but:
- [[wiki-links]] autocomplete works
- #tags autocomplete works
- Clicking links navigates
- All editor features remain
```

## Responsive Behavior

### Desktop (> 1200px)
```
              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃                                                      ┃
              ┃  Tuesday, December 9, 2025                       ◱   ┃
              ┃  ──────────────────────────────────────────────────  ┃
              ┃                                                      ┃
              ┃  [Editor content...]                                 ┃
              ┃                                                      ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Max-width: 700px
Centered in viewport
Comfortable reading width
Lots of whitespace on sides
```

### Tablet (768px - 1200px)
```
         ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
         ┃                                                               ┃
         ┃  Tuesday, December 9, 2025                                ◱   ┃
         ┃  ───────────────────────────────────────────────────────────  ┃
         ┃                                                               ┃
         ┃  [Editor content...]                                          ┃
         ┃                                                               ┃
         ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Max-width: 90% of viewport
Still centered
Slightly more padding on sides
```

### Mobile (< 768px)
```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                        ┃
┃  Tue, Dec 9, 2025                              ◱       ┃
┃  ────────────────────────────────────────────────────  ┃
┃                                                        ┃
┃  [Editor content - full width]                         ┃
┃                                                        ┃
┃  ────────────────────────────────────────────────────  ┃
┃  B I U │ 🔗 📷 │ ⋮ │ ◱                                 ┃
┃                                                        ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Full width (minus small padding)
Shorter date format
Focus Mode is essentially the default on mobile
```

## Day Card in Focus Mode

### Structure Comparison
```
FULL MODE DAY CARD:
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                                      ┃
┃   Monday                                                   ☀️ 72°F   ┃
┃   December 9, 2024                                                   ┃
┃   ────────────────────────────────────────────────────────────────   ┃
┃   ┌────────────────────────────────────────────────────────────────┐ ┃
┃   │ 📆  Calendar Events                            3 meetings   ⌄  │ ┃
┃   └────────────────────────────────────────────────────────────────┘ ┃
┃   ┌────────────────────────────────────────────────────────────────┐ ┃
┃   │ ⏱️  Overdue Tasks                                 5 tasks   ⌄  │ ┃
┃   └────────────────────────────────────────────────────────────────┘ ┃
┃   ┌────────────────────────────────────────────────────────────────┐ ┃
┃   │ 📝  Notes                                                 (2)  │ ┃
┃   │ [Note items...]                                                │ ┃
┃   └────────────────────────────────────────────────────────────────┘ ┃
┃   ┌────────────────────────────────────────────────────────────────┐ ┃
┃   │ ✏️  Journal                                                    │ ┃
┃   │ [Editor...]                                                    │ ┃
┃   │ ────────────────────────────────────────────────────────────── │ ┃
┃   │ B I U S │ 🔗 📷 🎤 📎 │ ⋮ │ ◱                                  │ ┃
┃   └────────────────────────────────────────────────────────────────┘ ┃
┃                                                                      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


FOCUS MODE DAY CARD:
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                           ┃
┃   Tuesday, December 9, 2025                           ◱   ┃
┃   ─────────────────────────────────────────────────────   ┃
┃                                                           ┃
┃   ┌─────────────────────────────────────────────────────┐ ┃
┃   │                                                     │ ┃
┃   │  [Journal Editor only - no section header]          │ ┃
┃   │                                                     │ ┃
┃   │                                                     │ ┃
┃   │                                                     │ ┃
┃   ├─────────────────────────────────────────────────────┤ ┃
┃   │  B  I  U  S │ 🔗 📷 🎤 📎 │ ⋮ │ ◱                   │ ┃
┃   └─────────────────────────────────────────────────────┘ ┃
┃                                                           ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Changes:
- No section header (no "✏️ Journal")
- No Calendar Events
- No Overdue Tasks
- No Notes section
- Simplified date header
- Editor is the only content
- Max-width: 700px, centered
```

## Exit Methods
```
METHOD 1: Click ◱ button (in toolbar or header)
┌───┐
│ ◱ │  → Return to Full Mode
└───┘

METHOD 2: Press Escape key
[Esc]  → Return to Full Mode

METHOD 3: Keyboard shortcut
Cmd/Ctrl + \  → Toggle Focus Mode
```

## State Persistence
```
Remember mode preference:

Storage:
- localStorage key: "memry_journal_view_mode"
- Values: "full" | "focus"

Behavior:
- On page load, restore last used mode
- Mode persists across sessions
- Per-device preference

// Save
localStorage.setItem('memry_journal_view_mode', 'focus');

// Restore
const mode = localStorage.getItem('memry_journal_view_mode') || 'full';
```

## Component Structure
```typescript
// JournalPage state
const [viewMode, setViewMode] = useState<'full' | 'focus'>('full');

// Restore from localStorage
useEffect(() => {
  const saved = localStorage.getItem('memry_journal_view_mode');
  if (saved === 'focus') setViewMode('focus');
}, []);

// Save on change
useEffect(() => {
  localStorage.setItem('memry_journal_view_mode', viewMode);
}, [viewMode]);

// Toggle function
const toggleFocusMode = () => {
  setViewMode(prev => prev === 'focus' ? 'full' : 'focus');
};

// Handle Escape key
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && viewMode === 'focus') {
      setViewMode('full');
    }
    if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
      toggleFocusMode();
    }
  };
  document.addEventListener('keydown', handleKeyDown);
  return () => document.removeEventListener('keydown', handleKeyDown);
}, [viewMode]);
```

## CSS Implementation
```css
/* Full Mode Layout */
.journal-page {
  display: flex;
  height: 100vh;
}

.journal-page .nav-sidebar {
  width: 200px;
  flex-shrink: 0;
  transition: width 200ms ease-out;
}

.journal-page .journal-area {
  flex: 1;
  overflow-y: auto;
}

.journal-page .right-sidebar {
  width: 35%;
  max-width: 400px;
  flex-shrink: 0;
  transition: transform 250ms ease-out, opacity 200ms ease-out;
}

/* Focus Mode */
.journal-page.focus-mode .nav-sidebar {
  width: 0;
  overflow: hidden;
}

.journal-page.focus-mode .right-sidebar {
  transform: translateX(100%);
  opacity: 0;
  position: absolute;
  right: 0;
}

.journal-page.focus-mode .journal-area {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.journal-page.focus-mode .day-card {
  max-width: 700px;
  width: 100%;
}

/* Section hiding in Focus Mode */
.journal-page.focus-mode .calendar-events-section,
.journal-page.focus-mode .overdue-tasks-section,
.journal-page.focus-mode .notes-section,
.journal-page.focus-mode .journal-section-header {
  display: none;
}

/* Day card transitions */
.day-card {
  transition: max-width 300ms ease-out;
}

.day-card-section {
  transition: opacity 200ms ease-out, max-height 200ms ease-out;
}
```

## Accessibility
```
Mode toggle button:
- aria-pressed="true" when Focus Mode active
- aria-label="Enter Focus Mode" / "Exit Focus Mode"
- Announce state change to screen readers

Hidden sections:
- Use display: none (not just opacity: 0)
- Ensures screen readers skip hidden content

Keyboard:
- Escape: Exit Focus Mode
- Cmd/Ctrl + \: Toggle Focus Mode

Screen reader announcements:
- "Entered Focus Mode"
- "Exited Focus Mode"
```

## Keyboard Shortcuts
```
TOGGLE FOCUS MODE:
- Cmd/Ctrl + \
- Or: Click ◱ button

EXIT FOCUS MODE:
- Escape
- Or: Click ◱ button

NAVIGATION IN FOCUS MODE:
- Scroll: Navigate between days
- Arrow keys: When not in editor
```

## Expected Output

After implementing this prompt:
1. ◱ button toggles between Full and Focus Mode
2. Sidebar hides/shows with slide animation
3. Nav sidebar collapses
4. Collapsible sections hide/show with fade
5. Notes section hides
6. Day card centers and constrains width
7. Header simplifies in Focus Mode
8. Editor remains fully functional
9. Wiki-links and tags still work
10. Infinite scroll still works
11. Mode persists across sessions
12. Escape key exits Focus Mode
13. Keyboard shortcut works (Cmd/Ctrl + \)
14. Proper accessibility announcements
15. Responsive behavior maintained

## What Was Removed (vs old Simple + Focus)
```
REMOVED:
- Simple Mode (merged into Focus Mode)
- Two separate toggle buttons
- "Single day only" restriction (can still scroll)
- Confusion between two similar modes

SIMPLIFIED:
- One toggle: Full ↔ Focus
- One keyboard shortcut
- One state to manage
- Clear purpose: "Hide distractions"
```