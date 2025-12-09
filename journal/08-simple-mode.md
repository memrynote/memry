# Memry Journal — Simple Mode

## Overview

Build Simple Mode, a distraction-reduced view that hides the sidebar and collapsible sections, centering the journal editor for a cleaner writing experience. This mode serves casual users who want simplicity without PKM complexity. Toggle via the ◱ button in the toolbar.

## Mode Comparison
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  FULL MODE (Default)                                                        │
│                                                                             │
│  ┌─────────────────────────────────────────────┬───────────────────────┐    │
│  │                                             │                       │    │
│  │  SCROLL AREA (65%)                          │  SIDEBAR (35%)        │    │
│  │                                             │                       │    │
│  │  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓   │  ┌─────────────────┐  │    │
│  │  ┃  December 9                          ┃   │  │ Calendar        │  │    │
│  │  ┃  ──────────────────────────────────  ┃   │  │ Heatmap         │  │    │
│  │  ┃  📆 Calendar Events          3  ⌄   ┃   │  └─────────────────┘  │    │
│  │  ┃  ⏱️ Overdue Tasks            5  ⌄   ┃   │  ┌─────────────────┐  │    │
│  │  ┃  📝 Notes                    (2)    ┃   │  │ AI Connections  │  │    │
│  │  ┃  ✏️ Journal                         ┃   │  └─────────────────┘  │    │
│  │  ┃  [Editor...]                        ┃   │  ┌─────────────────┐  │    │
│  │  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛   │  │ Today's Notes   │  │    │
│  │                                             │  └─────────────────┘  │    │
│  └─────────────────────────────────────────────┴───────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

                                    │
                                    │  Click ◱
                                    ▼

┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  SIMPLE MODE                                                                │
│                                                                             │
│                    ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓           │
│                    ┃                                            ┃           │
│                    ┃  December 9, 2024                    ◱  ⛶  ┃           │
│                    ┃  Monday                                    ┃           │
│                    ┃  ────────────────────────────────────────  ┃           │
│                    ┃                                            ┃           │
│                    ┃  [Journal Editor - wider, centered]        ┃           │
│                    ┃                                            ┃           │
│                    ┃  Today was productive...                   ┃           │
│                    ┃                                            ┃           │
│                    ┃  ────────────────────────────────────────  ┃           │
│                    ┃  B I U S │ 🔗 📷 🎤 📎 │ ⋮ │ ◱            ┃           │
│                    ┃                                            ┃           │
│                    ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛           │
│                                                                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## What Changes in Simple Mode

### Hidden Elements
```
HIDDEN:
├── Right Sidebar (entire sidebar)
│   ├── Calendar Heatmap
│   ├── AI Connections
│   └── Today's Notes
│
├── Collapsible Sections (within day card)
│   ├── 📆 Calendar Events
│   └── ⏱️ Overdue Tasks
│
└── Notes Section (within day card)
    └── 📝 Notes list

VISIBLE:
├── Day Header (simplified)
├── Journal Editor (wider)
└── Toolbar (with mode toggle)
```

### Layout Changes
```
Full Mode:
├── Scroll area: 65% width
├── Sidebar: 35% width
├── Day card: Full width of scroll area
└── Editor: Part of day card sections

Simple Mode:
├── Scroll area: 100% width (centered content)
├── Sidebar: Hidden (0% / display:none)
├── Day card: Max-width ~700px, centered
└── Editor: Primary focus, more vertical space
```

## Simple Mode Day Card

### Structure
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                                                                             │
│            ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓          │
│            ┃                                                     ┃          │
│            ┃  Monday, December 9, 2024                    ◱   ⛶  ┃          │
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
```

### Simplified Header
```
Full Mode Header:
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   Monday                                        ☀️ 72°F        │
│   December 9, 2024                                             │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Simple Mode Header:
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   Monday, December 9, 2024                            ◱    ⛶   │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Changes:
- Single line date format
- Weather hidden (optional, or keep if desired)
- Mode toggle buttons in header (quick access)
- Cleaner, less visual noise
```

## Toggle Button Behavior

### Button Location
```
In Toolbar (primary location):
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮  │  ◱                                  │
│                                       └──┬──┘                                │
│                                          └── Simple Mode toggle              │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

In Header (Simple Mode):
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   Monday, December 9, 2024                            ◱    ⛶   │
│                                                       │    │   │
│                                            Simple ────┘    │   │
│                                            Focus ──────────┘   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Button States
```
FULL MODE (Default):
┌───┐
│ ◱ │  ← Normal/inactive appearance
└───┘
Tooltip: "Enter Simple Mode"


SIMPLE MODE (Active):
┌───┐
│▓◱▓│  ← Highlighted/active appearance
└───┘
Tooltip: "Exit Simple Mode"


Button icon options:
◱  - Square with corner (expand/contract feel)
⊟  - Square with minus (simplify)
◫  - Square half-filled (partial view)
☐  - Simple square
⬚  - Dotted square
```

### Click Behavior
```
In Full Mode:
Click ◱ → Transition to Simple Mode

In Simple Mode:
Click ◱ → Return to Full Mode

Keyboard shortcut:
Cmd/Ctrl + \  → Toggle Simple Mode
```

## Transition Animation

### Full Mode → Simple Mode
```
STEP 1: User clicks ◱ button
        │
        ▼
STEP 2: Sidebar slides out to right

┌─────────────────────────────────┬──────────────────┐
│                                 │                  │
│  SCROLL AREA                    │  SIDEBAR         │───▶ (sliding out)
│                                 │                  │
└─────────────────────────────────┴──────────────────┘
        │
        ▼
STEP 3: Scroll area expands to fill space

┌────────────────────────────────────────────────────┐
│                                                    │
│  SCROLL AREA (expanding...)                        │
│                                                    │
└────────────────────────────────────────────────────┘
        │
        ▼
STEP 4: Day card sections fade out and collapse

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  December 9                                        ┃
┃  ────────────────────────────────────────────────  ┃
┃  📆 Calendar Events (fading...)                    ┃
┃  ⏱️ Overdue Tasks (fading...)                      ┃
┃  📝 Notes (fading...)                              ┃
┃  ✏️ Journal [stays visible, expanding]             ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
        │
        ▼
STEP 5: Day card centers and header simplifies

              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Monday, December 9, 2024    ◱ ⛶ ┃
              ┃  ──────────────────────────────  ┃
              ┃                                  ┃
              ┃  [Journal Editor - full focus]   ┃
              ┃                                  ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Animation timing:
- Total duration: 300ms
- Sidebar slide: 250ms ease-out
- Section fade: 200ms (starts at 50ms)
- Card center: 300ms ease-out (simultaneous)
- Header morph: 200ms
```

### Simple Mode → Full Mode
```
STEP 1: User clicks ◱ button
        │
        ▼
STEP 2: Day card expands to full width

              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃                                  ┃
              ┃  [Card expanding...]             ┃
              ┃                                  ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                    │
                    ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                    ┃
┃  [Card at full width]                              ┃
┃                                                    ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
        │
        ▼
STEP 3: Sidebar slides in from right

┌─────────────────────────────────┬──────────────────┐
│                                 │                  │
│  SCROLL AREA                    │←── SIDEBAR       │
│                                 │   (sliding in)   │
└─────────────────────────────────┴──────────────────┘
        │
        ▼
STEP 4: Sections fade in and expand

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  December 9                                        ┃
┃  ────────────────────────────────────────────────  ┃
┃  📆 Calendar Events (fading in...)                 ┃
┃  ⏱️ Overdue Tasks (fading in...)                   ┃
┃  📝 Notes (fading in...)                           ┃
┃  ✏️ Journal                                        ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Animation timing:
- Total duration: 300ms
- Card expand: 200ms ease-out
- Sidebar slide: 250ms ease-out
- Section fade-in: 200ms (starts at 100ms)
```

## Scroll Behavior in Simple Mode

### Infinite Scroll Still Works
```
Simple Mode maintains infinite scroll:

                         ▲
                         │  Scroll up for past days
                         │
              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Sunday, December 8, 2024        ┃  ← Past (faded)
              ┃  [Editor content...]             ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Monday, December 9, 2024        ┃  ← Active (100%)
              ┃  [Editor content...]             ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Tuesday, December 10, 2024      ┃  ← Future (faded)
              ┃  [Editor content...]             ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                         │
                         │  Scroll down for future days
                         ▼

Same behavior as Full Mode:
- Opacity gradient based on distance from center
- Active day detection
- Infinite loading at edges
```

### Quick Navigation
```
Without the calendar heatmap, provide alternative navigation:

Option A: Floating "Today" button
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│            ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓              │
│            ┃  Monday, December 9, 2024                  ◱ ⛶ ┃              │
│            ┃  ...                                           ┃              │
│            ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛              │
│                                                                             │
│                                                       ┌─────────┐          │
│                                                       │ [Today] │ ← Floating
│                                                       └─────────┘   button
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Shows when:
- User has scrolled away from today
- Fades in/out based on position

Click:
- Smooth scroll to today's card


Option B: Date in header is clickable
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   Monday, December 9, 2024  ⌄                         ◱    ⛶   │
│                            └─┬─┘                               │
│                              └── Click to open date picker     │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Click date:
- Opens calendar/date picker popover
- Select date to jump to that day
```

## PKM Features Still Active
```
In Simple Mode, wiki-links and tags still work:

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

Simple Mode hides the visual complexity, but:
- [[wiki-links]] autocomplete works
- #tags autocomplete works
- Clicking links navigates
- Content features remain
- Just fewer panels/sections visible
```

## Responsive Adjustments

### Desktop (> 1200px)
```
              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃                                                      ┃
              ┃  Monday, December 9, 2024                    ◱    ⛶  ┃
              ┃  ──────────────────────────────────────────────────  ┃
              ┃                                                      ┃
              ┃  [Editor content...]                                 ┃
              ┃                                                      ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Max-width: 700px
Centered in viewport
Comfortable reading width
```

### Tablet (768px - 1200px)
```
         ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
         ┃                                                               ┃
         ┃  Monday, December 9, 2024                             ◱    ⛶  ┃
         ┃  ───────────────────────────────────────────────────────────  ┃
         ┃                                                               ┃
         ┃  [Editor content...]                                          ┃
         ┃                                                               ┃
         ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Max-width: 90% of viewport (or 600px)
Still centered
Slightly more padding on sides
```

### Mobile (< 768px)
```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                        ┃
┃  Mon, Dec 9, 2024                              ◱    ⛶  ┃
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
Toolbar may condense (fewer visible buttons)

Note: On mobile, Simple Mode may be the default or only mode
since sidebar is already hidden in mobile Full Mode
```

## Day Card Differences

### Full Mode Day Card
```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                                      ┃
┃   Monday                                                   ☀️ 72°F   ┃
┃   December 9, 2024                                                   ┃
┃                                                                      ┃
┃   ────────────────────────────────────────────────────────────────   ┃
┃                                                                      ┃
┃   ┌────────────────────────────────────────────────────────────────┐ ┃
┃   │ 📆  Calendar Events                            3 meetings   ⌄  │ ┃
┃   └────────────────────────────────────────────────────────────────┘ ┃
┃                                                                      ┃
┃   ┌────────────────────────────────────────────────────────────────┐ ┃
┃   │ ⏱️  Overdue Tasks                                 5 tasks   ⌄  │ ┃
┃   └────────────────────────────────────────────────────────────────┘ ┃
┃                                                                      ┃
┃   ┌────────────────────────────────────────────────────────────────┐ ┃
┃   │ 📝  Notes                                                 (2)  │ ┃
┃   │ ────────────────────────────────────────────────────────────── │ ┃
┃   │ [Note items...]                                                │ ┃
┃   └────────────────────────────────────────────────────────────────┘ ┃
┃                                                                      ┃
┃   ┌────────────────────────────────────────────────────────────────┐ ┃
┃   │ ✏️  Journal                                                    │ ┃
┃   │ ────────────────────────────────────────────────────────────── │ ┃
┃   │ [Editor...]                                                    │ ┃
┃   │ ────────────────────────────────────────────────────────────── │ ┃
┃   │ B I U S │ 🔗 📷 🎤 📎 │ ⋮ │ ◱                                  │ ┃
┃   └────────────────────────────────────────────────────────────────┘ ┃
┃                                                                      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

### Simple Mode Day Card
```
              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃                                                      ┃
              ┃   Monday, December 9, 2024                   ◱    ⛶  ┃
              ┃                                                      ┃
              ┃   ──────────────────────────────────────────────────  ┃
              ┃                                                      ┃
              ┃   ┌──────────────────────────────────────────────┐   ┃
              ┃   │                                              │   ┃
              ┃   │  Today was productive. Had a great           │   ┃
              ┃   │  meeting with the team about                 │   ┃
              ┃   │  [[Project Alpha]]. We discussed the         │   ┃
              ┃   │  new timeline...                             │   ┃
              ┃   │                                              │   ┃
              ┃   │  #work #planning                             │   ┃
              ┃   │                                              │   ┃
              ┃   ├──────────────────────────────────────────────┤   ┃
              ┃   │  B  I  U  S │ 🔗 📷 🎤 📎 │ ⋮ │ ◱           │   ┃
              ┃   └──────────────────────────────────────────────┘   ┃
              ┃                                                      ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Changes:
- No section headers (no "✏️ Journal" label)
- Editor is the primary content
- Cleaner, less chrome
- Mode buttons in card header
```

## State Persistence
```
Remember mode preference:

Storage:
- localStorage key: "memry_journal_view_mode"
- Values: "full" | "simple" | "focus"

Behavior:
- On page load, restore last used mode
- Mode persists across sessions
- Can be reset to default in settings (optional)

Per-device:
- Mode preference is per-device (localStorage)
- Not synced across devices (user might want different modes on different devices)
```

## Component Changes

### JournalPage Component
```typescript
// State
const [viewMode, setViewMode] = useState('full');

// Restore from localStorage
useEffect(() => {
  const saved = localStorage.getItem('memry_journal_view_mode');
  if (saved) setViewMode(saved as ViewMode);
}, []);

// Save on change
useEffect(() => {
  localStorage.setItem('memry_journal_view_mode', viewMode);
}, [viewMode]);

// Toggle function
const toggleSimpleMode = () => {
  setViewMode(prev => prev === 'simple' ? 'full' : 'simple');
};

// Render
return (
  <div className={cn(
    "journal-page",
    viewMode === 'simple' && "simple-mode",
    viewMode === 'focus' && "focus-mode"
  )}>
    {viewMode !== 'focus' && (
      <ScrollArea className={cn(
        viewMode === 'simple' ? "w-full" : "w-[65%]"
      )}>
        {days.map(day => (

        ))}

    )}

    {viewMode === 'full' && (

    )}

);
```

### DayCard Component
```typescript
interface DayCardProps {
  // ... existing props
  viewMode: 'full' | 'simple' | 'focus';
  onToggleMode: () => void;
}

// Conditional rendering
return (
  <div className={cn(
    "day-card",
    viewMode === 'simple' && "simple-mode-card"
  )}>
    {viewMode === 'full' ? (

    ) : (

    )}

    {viewMode === 'full' && (
      <>
        {events.length > 0 && }
        {tasks.length > 0 && }

      </>
    )}

    <JournalSection
      content={journalContent}
      showSectionHeader={viewMode === 'full'}
      onToggleMode={onToggleMode}
    />

);
```

## CSS Classes
```css
/* Simple Mode Layout */
.journal-page.simple-mode {
  justify-content: center;
}

.journal-page.simple-mode .scroll-area {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.simple-mode-card {
  max-width: 700px;
  width: 100%;
  margin: 0 auto;
}

/* Transitions */
.scroll-area {
  transition: width 300ms ease-out;
}

.sidebar {
  transition: transform 300ms ease-out, opacity 250ms ease-out;
}

.journal-page.simple-mode .sidebar {
  transform: translateX(100%);
  opacity: 0;
  pointer-events: none;
  position: absolute;
  right: 0;
}

/* Section hiding */
.simple-mode-card .calendar-events-section,
.simple-mode-card .overdue-tasks-section,
.simple-mode-card .notes-section {
  display: none;
}

/* Or with animation */
.day-card-section {
  transition: opacity 200ms ease-out, max-height 200ms ease-out;
  overflow: hidden;
}

.simple-mode-card .day-card-section.hideable {
  opacity: 0;
  max-height: 0;
  padding: 0;
  margin: 0;
}
```

## Keyboard Shortcut
```
Toggle Simple Mode:
- Cmd/Ctrl + \

Announce:
- Screen reader: "Entered Simple Mode" / "Exited Simple Mode"
```

## Accessibility
```
Mode toggle button:
- aria-pressed="true/false"
- aria-label="Simple Mode" or "Exit Simple Mode"
- Announce state change

Hidden sections:
- Use display:none or aria-hidden="true"
- Don't just visually hide (opacity:0)
- Ensures screen readers skip hidden content
```

## Expected Output

After implementing this prompt:
1. ◱ button toggles between Full and Simple Mode
2. Sidebar hides/shows with slide animation
3. Collapsible sections hide/show with fade
4. Day card centers and constrains width
5. Header simplifies in Simple Mode
6. Editor remains fully functional
7. Wiki-links and tags still work
8. Infinite scroll still works
9. Mode persists across sessions
10. Keyboard shortcut works
11. Proper accessibility announcements
12. Responsive behavior maintained

## Do Not Include Yet

- Focus Mode (Prompt 09)
- Specific mobile considerations beyond responsive

Focus on the Full ↔ Simple toggle and layout changes.

Implementation Notes
TechniqueWhyCSS transitionsSmooth layout changesConditional renderingClean component logiclocalStoragePersist preferenceCSS classesEasy state-based stylingaria-pressedAccessibility for toggles
Expected Outcome
After implementing this prompt, you should have:

Working toggle between Full and Simple Mode
Smooth animations for all transitions
Centered, focused editor in Simple Mode
Hidden sidebar and sections
Persistent mode preference
All PKM features still functional