# Memry Journal — Focus Mode

## Overview

Build Focus Mode, the most distraction-free writing experience. This mode shows only the current day's journal editor in full screen with minimal chrome. No other days visible, no sidebar, no sections — just pure writing space. Perfect for deep journaling sessions.

## Mode Progression
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   FULL MODE ──────▶ SIMPLE MODE ──────▶ FOCUS MODE ──────▶ FULL MODE       │
│       ◱                  ◱                   ⛶                  ◱          │
│                                                                             │
│   Sidebar visible    Sidebar hidden      Full screen        Back to        │
│   All sections       Editor centered     Single day         normal         │
│   Multiple days      Multiple days       Editor only                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Mode Comparison
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  SIMPLE MODE                                                                │
│                                                                             │
│            ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓             │
│            ┃  Sunday, December 8              (past day)      ┃             │
│            ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛             │
│                                                                             │
│            ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓             │
│            ┃  Monday, December 9, 2024                ◱   ⛶  ┃             │
│            ┃  [Editor content...]                            ┃             │
│            ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛             │
│                                                                             │
│            ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓             │
│            ┃  Tuesday, December 10            (future day)    ┃             │
│            ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

                                    │
                                    │  Click ⛶
                                    ▼

┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  FOCUS MODE                                                                 │
│                                                                             │
│  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│  ┃                                                                       ┃  │
│  ┃   Monday, December 9, 2024                                   ✕   ⛶   ┃  │
│  ┃                                                                       ┃  │
│  ┃   ─────────────────────────────────────────────────────────────────   ┃  │
│  ┃                                                                       ┃  │
│  ┃                                                                       ┃  │
│  ┃   Today was productive. Had a great meeting with the team             ┃  │
│  ┃   about [[Project Alpha]]. We discussed the new timeline and          ┃  │
│  ┃   everyone seems aligned.                                             ┃  │
│  ┃                                                                       ┃  │
│  ┃   Key takeaways:                                                      ┃  │
│  ┃   • Deadline moved to Q2                                              ┃  │
│  ┃   • Need to hire 2 more engineers                                     ┃  │
│  ┃   • Budget approved for new tools                                     ┃  │
│  ┃                                                                       ┃  │
│  ┃   #work #planning                                                     ┃  │
│  ┃                                                                       ┃  │
│  ┃                                                                       ┃  │
│  ┃   ─────────────────────────────────────────────────────────────────   ┃  │
│  ┃   B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮  │  ⛶                          ┃  │
│  ┃                                                                       ┃  │
│  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## What Changes in Focus Mode

### Hidden Elements
```
HIDDEN:
├── Sidebar (already hidden from Simple Mode)
│
├── All other day cards
│   ├── Past days
│   └── Future days
│
├── Scroll area chrome
│   └── Multiple day containers
│
└── Any navigation elements
    └── (Except exit button)

VISIBLE:
├── Single day card (current/active day)
│   ├── Minimal header
│   ├── Journal editor (full focus)
│   └── Toolbar
│
└── Exit controls
```

### Layout Changes
```
Simple Mode:
├── Multiple days visible (scrollable)
├── Centered cards, max-width constraint
├── Day cards have borders/shadows
└── Scroll to navigate between days

Focus Mode:
├── Single day only
├── Full viewport coverage
├── Minimal/no card chrome (optional)
├── No scrolling between days
└── Editor fills available space
```

## Focus Mode Layout

### Full Structure
```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                                           ┃
┃   ┌─────────────────────────────────────────────────────────────────────┐ ┃
┃   │                                                                     │ ┃
┃   │   Monday, December 9, 2024                                 ✕    ⛶   │ ┃
┃   │                                                                     │ ┃
┃   └─────────────────────────────────────────────────────────────────────┘ ┃
┃                                                                           ┃
┃   ───────────────────────────────────────────────────────────────────────  ┃
┃                                                                           ┃
┃   ┌─────────────────────────────────────────────────────────────────────┐ ┃
┃   │                                                                     │ ┃
┃   │                                                                     │ ┃
┃   │   Today was productive. Had a great meeting with the team           │ ┃
┃   │   about [[Project Alpha]]. We discussed the new timeline and        │ ┃
┃   │   everyone seems aligned.                                           │ ┃
┃   │                                                                     │ ┃
┃   │   Key takeaways:                                                    │ ┃
┃   │   • Deadline moved to Q2                                            │ ┃
┃   │   • Need to hire 2 more engineers                                   │ ┃
┃   │   • Budget approved for new tools                                   │ ┃
┃   │                                                                     │ ┃
┃   │   Feeling optimistic about the direction. The team is motivated     │ ┃
┃   │   and we have clear goals for the quarter ahead.                    │ ┃
┃   │                                                                     │ ┃
┃   │   #work #planning #wins                                             │ ┃
┃   │                                                                     │ ┃
┃   │                                                                     │ ┃
┃   │                                                                     │ ┃
┃   │                                                                     │ ┃
┃   └─────────────────────────────────────────────────────────────────────┘ ┃
┃                                                                           ┃
┃   ───────────────────────────────────────────────────────────────────────  ┃
┃                                                                           ┃
┃   ┌─────────────────────────────────────────────────────────────────────┐ ┃
┃   │   B   I   U   S   │   🔗   📷   🎤   📎   │   ⋮   │   ⛶             │ ┃
┃   └─────────────────────────────────────────────────────────────────────┘ ┃
┃                                                                           ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

### Component Breakdown
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ HEADER                                                              │   │
│   │                                                                     │   │
│   │   [DATE]                                                [✕]  [⛶]   │   │
│   │                                                                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ EDITOR AREA                                                         │   │
│   │                                                                     │   │
│   │   flex: 1 (fills remaining vertical space)                          │   │
│   │                                                                     │   │
│   │   [Tiptap editor content]                                           │   │
│   │                                                                     │   │
│   │                                                                     │   │
│   │                                                                     │   │
│   │                                                                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ TOOLBAR                                                             │   │
│   │                                                                     │   │
│   │   [Formatting buttons]                                   [⛶]       │   │
│   │                                                                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Vertical layout:
├── Header: Fixed height (~60px)
├── Separator: 1px
├── Editor: flex: 1 (fills space)
├── Separator: 1px
└── Toolbar: Fixed height (~50px)
```

## Header Design

### Minimal Header
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   Monday, December 9, 2024                                         ✕    ⛶   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Layout:
┌─────────────────────────────────────────────────────────────────────────────┐
│  [DATE - Left aligned]                                    [CLOSE] [TOGGLE]  │
└─────────────────────────────────────────────────────────────────────────────┘

Elements:
- Date: Full format "Monday, December 9, 2024"
- Close button (✕): Exit Focus Mode, return to previous mode
- Toggle button (⛶): Indicates Focus Mode active, click to exit

Spacing:
- Padding: 16px 24px
- Date font: 16px, 500 weight
- Button size: 32px × 32px
- Gap between buttons: 8px
```

### Header Buttons
```
CLOSE BUTTON (✕):
┌───┐
│ ✕ │
└───┘

Properties:
- Exits Focus Mode entirely
- Returns to Simple Mode (or last non-focus mode)
- Keyboard: Escape key
- Tooltip: "Exit Focus Mode"
- aria-label: "Exit Focus Mode"


TOGGLE BUTTON (⛶):
┌───┐
│▓⛶▓│  ← Active/highlighted state
└───┘

Properties:
- Shows Focus Mode is active
- Click also exits Focus Mode
- Visual indicator that mode is on
- Tooltip: "Exit Focus Mode"

Button icon options for Focus:
⛶  - Full screen / expand
◉  - Filled circle (focused)
⊡  - Square with dot
⬤  - Filled circle
◼  - Filled square
```

## Editor in Focus Mode

### Full Height Editor
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   [Header]                                                                  │
│                                                                             │
│   ───────────────────────────────────────────────────────────────────────   │
│                                                                             │
│   ┌───────────────────────────────────────────────────────────────────┐     │
│   │                                                                   │     │
│   │   Today was productive. Had a great meeting...                    │     │
│   │                                                                   │     │
│   │   The editor fills all available vertical space.                  │     │
│   │   Content scrolls within this area if it exceeds                  │     │
│   │   the viewport height.                                            │  ▲  │
│   │                                                                   │  █  │
│   │   This creates a focused writing environment                      │  █  │
│   │   without distractions from other UI elements.                    │  █  │
│   │                                                                   │  █  │
│   │   • More content                                                  │  █  │
│   │   • Even more content                                             │  █  │
│   │   • Continues scrolling                                           │  ▼  │
│   │                                                                   │     │
│   └───────────────────────────────────────────────────────────────────┘     │
│                                                                             │
│   ───────────────────────────────────────────────────────────────────────   │
│                                                                             │
│   [Toolbar]                                                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Properties:
- Editor container: flex: 1
- Editor content: overflow-y: auto
- Scrollbar: Subtle, auto-hide (optional)
- Content: Max-width constraint for readability (700-800px, centered)
```

### Editor Content Width
```
Even in full-screen Focus Mode, maintain readable line length:

┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   [Header - full width]                                                     │
│                                                                             │
│   ───────────────────────────────────────────────────────────────────────   │
│                                                                             │
│         ┌─────────────────────────────────────────────────────┐             │
│         │                                                     │             │
│         │  Today was productive. Had a great meeting with     │             │
│         │  the team about [[Project Alpha]]. We discussed     │             │
│         │  the new timeline and everyone seems aligned.       │             │
│         │                                                     │             │
│         │  ← Max-width: 700px, centered →                     │             │
│         │                                                     │             │
│         │  Long lines of text are hard to read. By            │             │
│         │  constraining the width, we maintain comfortable    │             │
│         │  reading and writing ergonomics.                    │             │
│         │                                                     │             │
│         └─────────────────────────────────────────────────────┘             │
│                                                                             │
│   ───────────────────────────────────────────────────────────────────────   │
│                                                                             │
│   [Toolbar - full width or centered]                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Typography for Focus Mode:
- Font-size: 17px (slightly larger than normal 15px)
- Line-height: 1.8 (more spacious)
- Max-width: 700px
- Centered horizontally
```

## Toolbar in Focus Mode

### Simplified or Full Toolbar
```
Option A: Full toolbar (same as Simple Mode)
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   B   I   U   S   │   🔗   📷   🎤   📎   │   ⋮   │   ⛶                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘


Option B: Minimal toolbar (Focus Mode specific)
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                              B  I  U  │  ⋮  │  ⛶                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Rationale for Option A:
- Consistency with other modes
- All features still available
- User doesn't lose capability

Recommendation: Option A (Full toolbar)
```

### Auto-Hide Toolbar (Optional Enhancement)
```
Toolbar can auto-hide for maximum writing immersion:

IDLE STATE (after 3 seconds of no mouse movement):
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   [Header fades to minimal]                                                 │
│                                                                             │
│   ┌───────────────────────────────────────────────────────────────────┐     │
│   │                                                                   │     │
│   │   [Editor - full focus, slightly taller]                          │     │
│   │                                                                   │     │
│   │                                                                   │     │
│   │                                                                   │     │
│   └───────────────────────────────────────────────────────────────────┘     │
│                                                                             │
│   [Toolbar hidden or very subtle]                                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘


ACTIVE STATE (mouse moves or typing):
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   [Header visible]                                                          │
│                                                                             │
│   ───────────────────────────────────────────────────────────────────────   │
│                                                                             │
│   ┌───────────────────────────────────────────────────────────────────┐     │
│   │                                                                   │     │
│   │   [Editor]                                                        │     │
│   │                                                                   │     │
│   └───────────────────────────────────────────────────────────────────┘     │
│                                                                             │
│   ───────────────────────────────────────────────────────────────────────   │
│                                                                             │
│   [Toolbar visible]                                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Behavior:
- Header/toolbar fade out after 3s of inactivity
- Fade back in on mouse move or key press
- Transition: 500ms ease
- Always show on hover near edges
```

## Toggle Button Behavior

### Entry Points to Focus Mode
```
FROM FULL MODE:
┌───┐ ┌───┐
│ ◱ │ │ ⛶ │  ← Click ⛶ directly
└───┘ └───┘
        │
        ▼
    Focus Mode


FROM SIMPLE MODE:
┌───┐ ┌───┐
│◱◱◱│ │ ⛶ │  ← ◱ is active, click ⛶
└───┘ └───┘
        │
        ▼
    Focus Mode


Alternative: Sequential toggle
┌───┐
│ ◱ │  Click repeatedly:
└───┘  Full → Simple → Focus → Full
```

### Exit Points from Focus Mode
```
METHOD 1: Click ✕ button
┌───┐
│ ✕ │  → Exit to Simple Mode (or last mode)
└───┘

METHOD 2: Click ⛶ button
┌───┐
│ ⛶ │  → Exit to Simple Mode
└───┘

METHOD 3: Press Escape key
Escape → Exit to Simple Mode

METHOD 4: Keyboard shortcut
Cmd/Ctrl + Shift + F → Toggle Focus Mode
```

## Transition Animations

### Simple Mode → Focus Mode
```
STEP 1: User clicks ⛶ button
        │
        ▼
STEP 2: Other day cards fade out

              ┏━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Dec 8  (fading...)  ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━┛

              ┏━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Dec 9  (stays)      ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━┛

              ┏━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Dec 10 (fading...)  ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━┛
        │
        ▼
STEP 3: Active card expands to fill viewport

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                                     ┃
┃  Monday, December 9, 2024                                  ✕    ⛶   ┃
┃                                                                     ┃
┃  ─────────────────────────────────────────────────────────────────  ┃
┃                                                                     ┃
┃  [Editor expands to fill space]                                     ┃
┃                                                                     ┃
┃  ─────────────────────────────────────────────────────────────────  ┃
┃                                                                     ┃
┃  [Toolbar]                                                          ┃
┃                                                                     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Animation timing:
- Other cards fade: 200ms ease-out
- Active card expand: 300ms ease-out
- Total duration: ~350ms (overlapping)
```

### Focus Mode → Simple Mode
```
STEP 1: User clicks ✕ or ⛶ or presses Escape
        │
        ▼
STEP 2: Full-screen card shrinks to centered card

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                                     ┃
┃  [Card shrinking...]                                                ┃
┃                                                                     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
        │
        ▼

              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Monday, December 9, 2024    ◱ ⛶ ┃
              ┃  [Editor content...]             ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
        │
        ▼
STEP 3: Adjacent day cards fade in

              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Sunday, December 8 (fading in)  ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Monday, December 9, 2024    ◱ ⛶ ┃
              ┃  [Editor content...]             ┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

              ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
              ┃  Tuesday, December 10 (fading in)┃
              ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Animation timing:
- Card shrink: 300ms ease-out
- Other cards fade in: 200ms ease-out (starts at 150ms)
- Total duration: ~350ms
```

## Background/Overlay

### Focus Mode Background
```
Option A: Solid background (same as app)
┌─────────────────────────────────────────────────────────────────────────────┐
│█████████████████████████████████████████████████████████████████████████████│
│█████████████████████████████████████████████████████████████████████████████│
│██                                                                         ██│
│██   [Focus Mode Content]                                                  ██│
│██                                                                         ██│
│█████████████████████████████████████████████████████████████████████████████│
│█████████████████████████████████████████████████████████████████████████████│
└─────────────────────────────────────────────────────────────────────────────┘

Same background color as app
Clean, consistent


Option B: Slightly dimmed/different background
┌─────────────────────────────────────────────────────────────────────────────┐
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓                                                                         ▓▓│
│▓▓   [Focus Mode Content - slightly lighter]                               ▓▓│
│▓▓                                                                         ▓▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
└─────────────────────────────────────────────────────────────────────────────┘

Slightly different to indicate mode change
Subtle visual cue


Option C: Gradient or vignette (subtle)
┌─────────────────────────────────────────────────────────────────────────────┐
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
│░░                                                                         ░░│
│                                                                             │
│     [Focus Mode Content - bright center]                                    │
│                                                                             │
│░░                                                                         ░░│
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
└─────────────────────────────────────────────────────────────────────────────┘

Subtle vignette draws eye to center
Can feel calming/focused

Recommendation: Option A or B (simple, clean)
```

## Date Navigation in Focus Mode

### Changing Days
```
In Focus Mode, how does the user change which day they're viewing?

Option A: No day navigation (must exit Focus Mode)
- Focus Mode = single day, period
- To view different day, exit Focus Mode first
- Simple and clear

Option B: Minimal navigation arrows
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ◀  Monday, December 9, 2024  ▶                                    ✕    ⛶   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

◀ = Previous day
▶ = Next day
Click date = date picker


Option C: Keyboard-only navigation
- Left arrow = Previous day (when not typing)
- Right arrow = Next day (when not typing)
- No visible buttons

Recommendation: Option A initially (simplest)
Can add Option B as enhancement later
```

## Responsive Behavior

### Desktop (> 1200px)
```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                                           ┃
┃   Monday, December 9, 2024                                        ✕    ⛶  ┃
┃                                                                           ┃
┃   ─────────────────────────────────────────────────────────────────────   ┃
┃                                                                           ┃
┃              ┌─────────────────────────────────────────────┐              ┃
┃              │                                             │              ┃
┃              │  [Editor - max-width: 700px, centered]      │              ┃
┃              │                                             │              ┃
┃              │                                             │              ┃
┃              │                                             │              ┃
┃              └─────────────────────────────────────────────┘              ┃
┃                                                                           ┃
┃   ─────────────────────────────────────────────────────────────────────   ┃
┃                                                                           ┃
┃   [Toolbar]                                                               ┃
┃                                                                           ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Lots of whitespace on sides
Editor centered for comfortable reading
```

### Tablet (768px - 1200px)
```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                            ┃
┃   Monday, December 9, 2024                         ✕    ⛶  ┃
┃                                                            ┃
┃   ──────────────────────────────────────────────────────   ┃
┃                                                            ┃
┃        ┌──────────────────────────────────────────┐        ┃
┃        │                                          │        ┃
┃        │  [Editor - wider, still constrained]     │        ┃
┃        │                                          │        ┃
┃        └──────────────────────────────────────────┘        ┃
┃                                                            ┃
┃   ──────────────────────────────────────────────────────   ┃
┃                                                            ┃
┃   [Toolbar]                                                ┃
┃                                                            ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Editor: max-width: 90% or 600px
Still comfortable reading width
```

### Mobile (< 768px)
```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                    ┃
┃   Mon, Dec 9, 2024          ✕  ⛶   ┃
┃                                    ┃
┃   ──────────────────────────────   ┃
┃                                    ┃
┃   ┌──────────────────────────────┐ ┃
┃   │                              │ ┃
┃   │  [Editor - full width]       │ ┃
┃   │                              │ ┃
┃   │                              │ ┃
┃   │                              │ ┃
┃   │                              │ ┃
┃   │                              │ ┃
┃   │                              │ ┃
┃   └──────────────────────────────┘ ┃
┃                                    ┃
┃   ──────────────────────────────   ┃
┃                                    ┃
┃   B I U │ 🔗 📷 │ ⋮ │ ⛶           ┃
┃                                    ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Full width (with small padding)
Shorter date format
Condensed toolbar if needed
True mobile-first experience
```

## State Persistence
```
Focus Mode preference:

Storage:
- Same key as other modes: "memry_journal_view_mode"
- Values: "full" | "simple" | "focus"

Behavior:
- Mode persists across sessions
- If Focus Mode is saved, opens to Focus Mode on return
- Remembers which day was being viewed

Additional storage for Focus Mode:
- "memry_focus_date": "2024-12-09"
- Remembers the specific day user was focused on
```

## Keyboard Shortcuts
```
ENTER FOCUS MODE:
- Cmd/Ctrl + Shift + F
- Or: Cmd/Ctrl + . (period)

EXIT FOCUS MODE:
- Escape
- Cmd/Ctrl + Shift + F (toggle)

NAVIGATION (if enabled):
- Cmd/Ctrl + ← : Previous day
- Cmd/Ctrl + → : Next day
- Cmd/Ctrl + T : Jump to Today
```

## Component Structure
```
FocusMode (or conditional within JournalPage)
├── FocusModeContainer
│   ├── FocusHeader
│   │   ├── DateDisplay
│   │   ├── CloseButton
│   │   └── ToggleButton
│   │
│   ├── Separator
│   │
│   ├── EditorContainer
│   │   └── TiptapEditor
│   │       └── (same editor as other modes)
│   │
│   ├── Separator
│   │
│   └── Toolbar
│       └── (same toolbar as other modes)
│
└── (Background/overlay if needed)
```

## CSS Implementation
```css
/* Focus Mode Container */
.focus-mode {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: var(--background);
  display: flex;
  flex-direction: column;
}

/* Focus Mode Header */
.focus-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  flex-shrink: 0;
}

.focus-header-date {
  font-size: 16px;
  font-weight: 500;
}

.focus-header-buttons {
  display: flex;
  gap: 8px;
}

/* Focus Mode Editor */
.focus-editor-container {
  flex: 1;
  overflow-y: auto;
  display: flex;
  justify-content: center;
  padding: 24px;
}

.focus-editor {
  width: 100%;
  max-width: 700px;
  font-size: 17px;
  line-height: 1.8;
}

/* Focus Mode Toolbar */
.focus-toolbar {
  flex-shrink: 0;
  padding: 12px 24px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: center;
}

/* Transitions */
.focus-mode-enter {
  opacity: 0;
}
.focus-mode-enter-active {
  opacity: 1;
  transition: opacity 300ms ease-out;
}
.focus-mode-exit {
  opacity: 1;
}
.focus-mode-exit-active {
  opacity: 0;
  transition: opacity 200ms ease-in;
}
```

## Accessibility
```
Focus Mode:
- role="dialog" or role="main" (full page takeover)
- aria-label="Focus Mode - December 9, 2024"
- Focus trapped within Focus Mode
- Escape key exits (standard dialog behavior)

Close button:
- aria-label="Exit Focus Mode"
- First focusable element (or last, depending on tab order preference)

Screen reader announcement:
- On enter: "Entered Focus Mode for December 9, 2024"
- On exit: "Exited Focus Mode"

Keyboard:
- All keyboard shortcuts still work
- Tab navigates: Header buttons → Editor → Toolbar buttons
- Escape exits
```

## Data Structure
```typescript
interface ViewModeState {
  mode: 'full' | 'simple' | 'focus';
  focusDate?: string;  // The date being viewed in Focus Mode
}

// Actions
function enterFocusMode(date: string) {
  setViewMode({
    mode: 'focus',
    focusDate: date
  });
  // Save to localStorage
}

function exitFocusMode() {
  setViewMode({
    mode: 'simple',  // or previous mode
    focusDate: undefined
  });
}
```

## Expected Output

After implementing this prompt:
1. ⛶ button enters Focus Mode from Simple Mode
2. Full-screen editor view for single day
3. Other day cards are hidden
4. Minimal header with date and exit buttons
5. ✕ and ⛶ buttons exit Focus Mode
6. Escape key exits Focus Mode
7. Smooth enter/exit animations
8. Editor fills available vertical space
9. Content width constrained for readability
10. Full toolbar functionality preserved
11. Wiki-links and tags still work
12. Mode persists across sessions
13. Responsive on all screen sizes
14. Proper accessibility attributes

## Do Not Include Yet

- Day navigation within Focus Mode
- Auto-hide header/toolbar
- Theme changes specific to Focus Mode
- Typewriter mode (cursor stays centered)

Focus on the core Focus Mode experience.

Implementation Notes
TechniqueWhyposition: fixedFull viewport coverageflex: 1 on editorFill remaining spacemax-width on contentReadable line lengthz-index layeringOverlay other contentCSS transitionsSmooth mode changes
Expected Outcome
After implementing this prompt, you should have:

Working Focus Mode toggle
Full-screen single-day editor
Smooth transitions in/out
Exit via button, click, or Escape
Responsive on all devices
Persistent mode preference
Full editor functionality preserved