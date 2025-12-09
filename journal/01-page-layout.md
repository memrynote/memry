# Memry Journal — Page Layout

## Overview

Build the main page layout for the Memry Journal. This is a two-column layout with an infinite scroll area on the left and a fixed sidebar on the right.

## Layout Structure

The page is divided into two main sections:
```
┌──────────────────────────────────────────────────────────────────────────────┐
│  APP HEADER (if exists, from parent layout)                                  │
├──────────────────────────────────────────────┬───────────────────────────────┤
│                                              │                               │
│                                              │                               │
│                                              │                               │
│           LEFT SECTION                       │       RIGHT SECTION           │
│           (Scrollable)                       │       (Fixed/Sticky)          │
│                                              │                               │
│           Width: ~65%                        │       Width: ~35%             │
│           Min-width: 600px                   │       Min-width: 320px        │
│                                              │       Max-width: 400px        │
│                                              │                               │
│           Content: Day Cards                 │       Content: Sidebar        │
│           Overflow: scroll (vertical)        │       Position: sticky        │
│                                              │       Top: 0                  │
│                                              │       Height: 100vh           │
│                                              │                               │
│                                              │                               │
│                                              │                               │
└──────────────────────────────────────────────┴───────────────────────────────┘
```

## Section Details

### Left Section (Scroll Area)

This section contains the infinite scroll of day cards.
```
┌──────────────────────────────────────────────┐
│                                              │
│           SCROLL CONTAINER                   │
│                                              │
│    Padding: 24px horizontal, 40px vertical   │
│                                              │
│    ┌──────────────────────────────────────┐  │
│    │         DAY CARD (past)              │  │
│    └──────────────────────────────────────┘  │
│                                              │
│              Gap: 24px                       │
│                                              │
│    ┌──────────────────────────────────────┐  │
│    │         DAY CARD (active)            │  │
│    └──────────────────────────────────────┘  │
│                                              │
│              Gap: 24px                       │
│                                              │
│    ┌──────────────────────────────────────┐  │
│    │         DAY CARD (future)            │  │
│    └──────────────────────────────────────┘  │
│                                              │
└──────────────────────────────────────────────┘

Properties:
- Vertical scroll enabled
- Horizontal scroll disabled
- Scroll behavior: smooth
- Hide scrollbar visually (optional, keep functionality)
- Day cards stack vertically with consistent gap
```

### Right Section (Sidebar)

This section is fixed and contains calendar, AI connections, and notes.
```
┌───────────────────────────────┐
│                               │
│       SIDEBAR CONTAINER       │
│                               │
│    Position: sticky           │
│    Top: 0                     │
│    Height: 100vh              │
│    Overflow-y: auto           │
│    Padding: 24px              │
│    Border-left: 1px solid     │
│    Background: slightly       │
│                different      │
│                from main      │
│                               │
│    ┌───────────────────────┐  │
│    │  Calendar Section     │  │
│    └───────────────────────┘  │
│                               │
│    ┌───────────────────────┐  │
│    │  AI Connections       │  │
│    └───────────────────────┘  │
│                               │
│    ┌───────────────────────┐  │
│    │  Today's Notes        │  │
│    └───────────────────────┘  │
│                               │
└───────────────────────────────┘

Properties:
- Stays in place while left section scrolls
- Has its own internal scroll if content overflows
- Subtle left border to separate from main content
- Slightly different background shade for visual separation
```

## Divider Between Sections
```
        LEFT          │        RIGHT
                      │
                      │  ← 1px border
                      │     Color: subtle gray/border color
                      │     Creates visual separation
                      │
```

## Responsive Behavior

### Desktop (> 1200px)
```
┌────────────────────────────────┬─────────────────────┐
│         LEFT: 65%              │     RIGHT: 35%      │
│         Scroll Area            │     Sidebar         │
└────────────────────────────────┴─────────────────────┘
```

### Tablet (768px - 1200px)
```
┌────────────────────────────────┬─────────────────────┐
│         LEFT: 60%              │     RIGHT: 40%      │
│         Min-width: 500px       │     Min: 300px      │
└────────────────────────────────┴─────────────────────┘
```

### Mobile (< 768px)
```
┌──────────────────────────────────────────────────────┐
│                    LEFT: 100%                        │
│                    Scroll Area                       │
├──────────────────────────────────────────────────────┤
│  Sidebar becomes a drawer/sheet from right edge      │
│  Toggle button appears in header to open sidebar     │
└──────────────────────────────────────────────────────┘
```

## Component Hierarchy
```
JournalPage
├── LeftSection (ScrollArea)
│   └── DayCardsContainer
│       ├── DayCard (past days...)
│       ├── DayCard (active/today)
│       └── DayCard (future days...)
│
└── RightSection (Sidebar)
    ├── CalendarSection
    ├── AIConnectionsSection
    └── TodaysNotesSection
```

## Visual Specifications

### Colors (adapt to your theme)
```
Left Section Background:   Main background color
Right Section Background:  Slightly darker/lighter than main
Border Color:              Subtle separator color
```

### Spacing
```
Page Padding:              0 (full bleed)
Left Section Padding:      24px horizontal, 40px vertical
Right Section Padding:     24px all sides
Gap between Day Cards:     24px
Gap between Sidebar items: 20px
```

### Dimensions
```
Left Section:
  - Width: 65% (flexible)
  - Min-width: 600px

Right Section:
  - Width: 35% (flexible)
  - Min-width: 320px
  - Max-width: 400px

Day Card:
  - Width: 100% of container
  - Max-width: 800px (optional, for very wide screens)
  - Centered within left section
```

## States

### Default State
- Left section shows day cards with smooth scroll
- Right section is visible and sticky
- Both sections have their full content

### Simple Mode State
- Right section is hidden (width: 0, or display: none with animation)
- Left section expands to full width
- Day card centers in the available space
- Smooth transition animation (300ms)

### Mobile State
- Right section becomes a slide-out drawer
- Toggle button appears in header/toolbar
- Drawer slides from right edge
- Overlay behind drawer when open

## Scroll Behavior

The left section scroll should:
1. Allow vertical scrolling through all day cards
2. Use smooth scroll behavior for programmatic scrolling
3. Support scroll snap (optional) - snap to nearest day card
4. Track scroll position to determine active day (for opacity logic)
```
Scroll Position Detection:
- Track which day card is closest to viewport center
- This card becomes the "active" day
- Other cards adjust opacity based on distance from center
- Calendar in sidebar highlights the active day
```

## Expected Output

A page component that:
1. Renders a two-column layout
2. Left column scrolls vertically with day cards
3. Right column stays fixed while scrolling
4. Responsive down to mobile with drawer pattern
5. Supports Simple Mode (sidebar hidden)
6. Has proper spacing and visual hierarchy

## Placeholder Content

For now, use placeholder content:
- Left section: Empty container ready for day cards
- Right section: Three placeholder boxes for Calendar, AI Connections, Notes

## Do Not Include Yet

- Actual day card content (Prompt 03)
- Infinite scroll logic (Prompt 02)
- Calendar component (Prompt 04)
- Any other detailed components

Just focus on the foundational layout structure.

Implementation Notes
TechniqueWhySticky positioning for sidebarKeeps sidebar visible while main content scrollsFlexbox for two-column layoutEasy responsive handlingCSS custom propertiesTheme-able colors and spacingViewport-based heightSidebar fills available heightSmooth scroll behaviorBetter UX for calendar navigation
Expected Outcome
After implementing this prompt, you should have:

A working two-column layout
Scrollable left section
Fixed right sidebar
Responsive behavior on different screen sizes
Placeholder containers ready for content