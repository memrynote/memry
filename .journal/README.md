# Journal Feature Implementation Guide

## Overview

This directory contains a structured, step-by-step implementation guide for building the Journal page in Memry - a daily note-taking feature with a timeline-based interface, rich text editing, and activity visualization.

## Feature Description

The Journal is an infinite-scroll timeline where each day gets its own card. Users can write daily notes using a rich text editor (Tiptap), navigate between days via keyboard shortcuts or a calendar widget, and see their writing activity visualized as a heat map.

### Key Characteristics

- **Centered Timeline Layout**: Vertical scroll with day cards that fade in/out based on viewport position
- **Today-Focused Design**: Current day is always prominent (100% opacity, subtle scale)
- **Rich Text Editing**: Full Tiptap editor, not basic textarea
- **Activity Visualization**: Calendar heat map showing note density
- **Distraction-Free Mode**: Toggle focus mode to hide sidebar
- **Density Control**: User can choose compact/balanced/spacious layouts
- **Smooth Navigation**: Keyboard shortcuts and calendar-based jumps

## Visual Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ App Header                                                          │
├─────────────────────────────────────┬───────────────────────────────┤
│                                     │                               │
│  ┌─────────────────────────────┐   │  ┌─────────────────────────┐  │
│  │ Tomorrow (50% opacity)      │   │  │  Calendar Heat Map      │  │
│  │ Future date, dotted border  │   │  │  ┌─┬─┬─┬─┬─┬─┬─┐        │  │
│  │                             │   │  │  │■│■│ │■│■│■│ │        │  │
│  └─────────────────────────────┘   │  │  └─┴─┴─┴─┴─┴─┴─┘        │  │
│                                     │  │  Click to jump to day   │  │
│  ┌═════════════════════════════┐   │  └─────────────────────────┘  │
│  ║ TODAY (100%, scale 1.02x)   ║   │                               │
│  ║ Accent border, full editor  ║   │  ┌─────────────────────────┐  │
│  ║                             ║   │  │  Today's Notes          │  │
│  ║ [Rich Text Editor]          ║   │  │  • 9:34 AM - Meeting... │  │
│  ║ [Formatting Toolbar]        ║   │  │  • 2:15 PM - Ideas for..│  │
│  ║                             ║   │  │  • 5:47 PM - Quick note │  │
│  ║                             ║   │  └─────────────────────────┘  │
│  ╚═════════════════════════════╝   │                               │
│                                     │  [Today Button]               │
│  ┌─────────────────────────────┐   │  [Focus Mode Toggle]          │
│  │ Yesterday (75% opacity)     │   │  [Density Slider]             │
│  │ Past day, read-only preview │   │                               │
│  └─────────────────────────────┘   │                               │
│                                     │                               │
│  ┌─────────────────────────────┐   │                               │
│  │ 2 Days Ago (60% opacity)    │   │                               │
│  └─────────────────────────────┘   │                               │
│                                     │                               │
│  [Infinite scroll continues...]    │                               │
│                                     │                               │
└─────────────────────────────────────┴───────────────────────────────┘
```

## Components to Build

### Core Components

1. **JournalPage** (`src/renderer/src/pages/JournalPage.tsx`)
   - Main container with layout grid
   - State management for scroll position, focus mode, density
   - Keyboard shortcut handlers

2. **JournalTimeline** (`src/renderer/src/components/journal/JournalTimeline.tsx`)
   - Infinite scroll container with virtual scrolling
   - Fade-to-focus opacity/scale calculations
   - Scroll-to-date navigation

3. **DayCard** (`src/renderer/src/components/journal/DayCard.tsx`)
   - Individual day entry container
   - Date header with formatting
   - State-based styling (today/past/future)
   - Collapse/expand for past days

4. **JournalEditor** (`src/renderer/src/components/journal/JournalEditor.tsx`)
   - Tiptap rich text editor wrapper
   - Custom toolbar with formatting options
   - Auto-save functionality
   - Timestamp tracking

5. **CalendarHeatMap** (`src/renderer/src/components/journal/CalendarHeatMap.tsx`)
   - Month/year view with day cells
   - Activity density color coding
   - Click handler for date navigation
   - Tooltip showing note count

6. **TodaysNotesList** (`src/renderer/src/components/journal/TodaysNotesList.tsx`)
   - Scrollable list of today's entries
   - Timestamp + preview text
   - Click to scroll to note in editor

7. **JournalSidebar** (`src/renderer/src/components/journal/JournalSidebar.tsx`)
   - Right sidebar container
   - Calendar, notes list, controls
   - Collapsible in focus mode

8. **DensitySlider** (`src/renderer/src/components/journal/DensitySlider.tsx`)
   - Three-state toggle: Compact/Balanced/Spacious
   - Updates day card spacing/sizing

9. **FocusModeToggle** (`src/renderer/src/components/journal/FocusModeToggle.tsx`)
   - Button to hide sidebar
   - Center editor for distraction-free writing

### Utility Components

10. **EmptyJournalState** (`src/renderer/src/components/journal/EmptyJournalState.tsx`)
    - First-time user welcome screen
    - Prompts to start writing

11. **DateNavigator** (`src/renderer/src/components/journal/DateNavigator.tsx`)
    - Quick jump to specific date
    - Prev/next day buttons

## Implementation Roadmap

### Phase 1: Foundation (Prompts 01-02)
- Install dependencies (Tiptap, date libraries)
- Create folder structure and type definitions
- Build basic DayCard component with styling states

### Phase 2: Timeline & Scrolling (Prompts 03)
- Implement infinite scroll timeline
- Add fade-to-focus opacity/scale effect
- Calculate viewport-based styling

### Phase 3: Editor Integration (Prompt 04)
- Set up Tiptap editor with extensions
- Build custom toolbar
- Implement auto-save

### Phase 4: Sidebar Widgets (Prompts 05-06)
- Calendar heat map with activity visualization
- Today's notes list with timestamps
- Click handlers for navigation

### Phase 5: User Controls (Prompts 07-08)
- Focus mode toggle
- Density slider (compact/balanced/spacious)
- Preferences persistence

### Phase 6: Interactions (Prompts 09-10)
- Keyboard shortcuts (Cmd+T, Cmd+J, Cmd+↑/↓)
- Smooth scroll animations
- Calendar click navigation

### Phase 7: Polish & Edge Cases (Prompts 11-12)
- Empty states
- Loading states
- Error handling
- Integration testing

## Design Specifications

### Colors (Tailwind CSS Variables)

```css
/* Day Card States */
--today-opacity: 1.0
--today-scale: 1.02
--today-border: hsl(var(--primary))

--yesterday-opacity: 0.75
--yesterday-scale: 1.0

--past-opacity: 0.6
--past-scale: 0.98

--future-opacity: 0.5 to 0.7 (gradient)
--future-border: dashed 2px hsl(var(--border))

/* Heat Map Colors (note density) */
--heat-0: hsl(var(--muted))           /* No notes */
--heat-1: hsl(var(--primary) / 0.2)   /* 1-2 notes */
--heat-2: hsl(var(--primary) / 0.4)   /* 3-5 notes */
--heat-3: hsl(var(--primary) / 0.6)   /* 6-10 notes */
--heat-4: hsl(var(--primary) / 0.8)   /* 11+ notes */
```

### Spacing & Sizing

```typescript
// Density modes
const DENSITY = {
  compact: {
    cardGap: '1rem',        // space-y-4
    cardPadding: '1rem',    // p-4
    fontSize: 'text-sm',
    editorHeight: '12rem'   // h-48
  },
  balanced: {
    cardGap: '1.5rem',      // space-y-6
    cardPadding: '1.5rem',  // p-6
    fontSize: 'text-base',
    editorHeight: '16rem'   // h-64
  },
  spacious: {
    cardGap: '2.5rem',      // space-y-10
    cardPadding: '2rem',    // p-8
    fontSize: 'text-lg',
    editorHeight: '20rem'   // h-80
  }
}
```

### Animation Timings

```css
/* Scroll to date */
scroll-behavior: smooth;
transition-duration: 800ms;
transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);

/* Fade-to-focus */
transition: opacity 300ms ease, transform 300ms ease;

/* Calendar click feedback */
transform: scale(0.95);
transition: transform 150ms ease;
```

### Typography

```typescript
// Date headers
today: "text-2xl font-bold"
past: "text-xl font-semibold text-muted-foreground"
future: "text-xl font-medium text-muted-foreground/50"

// Notes list timestamps
"text-xs text-muted-foreground"

// Note previews
"text-sm line-clamp-1"
```

## Dependencies to Install

```bash
# Tiptap editor
pnpm add @tiptap/react @tiptap/starter-kit @tiptap/extension-placeholder

# Additional Tiptap extensions
pnpm add @tiptap/extension-link @tiptap/extension-task-list @tiptap/extension-task-item

# Date utilities
pnpm add date-fns

# Virtual scrolling (optional, if needed for performance)
pnpm add @tanstack/react-virtual

# State management (if not already installed)
pnpm add zustand
```

## Data Storage Strategy

### Local Storage Structure

```typescript
interface JournalEntry {
  id: string;
  date: string; // ISO 8601 date string
  content: string; // Tiptap JSON or HTML
  timestamps: {
    created: Date;
    lastModified: Date;
    updates: Array<{ time: Date; note: string }>;
  };
  wordCount: number;
  noteCount: number; // Number of distinct notes for the day
}

// Storage key pattern
localStorage: {
  'journal:entry:2024-01-15': JournalEntry,
  'journal:entry:2024-01-16': JournalEntry,
  'journal:preferences': {
    density: 'balanced',
    focusMode: false
  }
}
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+T` (Mac) / `Ctrl+T` (Win) | Jump to today |
| `Cmd+J` (Mac) / `Ctrl+J` (Win) | Open date picker |
| `Cmd+↑` | Scroll to previous day |
| `Cmd+↓` | Scroll to next day |
| `Cmd+F` (Mac) / `Ctrl+F` (Win) | Toggle focus mode |
| `Cmd+/` (Mac) / `Ctrl+/` (Win) | Show keyboard shortcuts |

## Accessibility Considerations

- All interactive elements must be keyboard accessible
- Calendar heat map cells need aria-labels with date and note count
- Focus mode should maintain logical tab order
- Day cards should have proper heading hierarchy (h2 for dates)
- Editor should have aria-label describing purpose
- Announce day changes to screen readers during scroll

## File Structure

```
src/renderer/src/
├── pages/
│   └── JournalPage.tsx
├── components/
│   └── journal/
│       ├── JournalTimeline.tsx
│       ├── DayCard.tsx
│       ├── JournalEditor.tsx
│       ├── CalendarHeatMap.tsx
│       ├── TodaysNotesList.tsx
│       ├── JournalSidebar.tsx
│       ├── DensitySlider.tsx
│       ├── FocusModeToggle.tsx
│       ├── EmptyJournalState.tsx
│       └── DateNavigator.tsx
├── lib/
│   ├── hooks/
│   │   ├── useJournalEntries.ts
│   │   ├── useScrollFade.ts
│   │   └── useKeyboardShortcuts.ts
│   └── journal/
│       ├── storage.ts
│       ├── date-utils.ts
│       └── types.ts
└── styles/
    └── journal.css (if needed for Tiptap overrides)
```

## Implementation Order

Follow the prompts in numerical order:

1. `01-project-setup.md` - Dependencies, types, folder structure
2. `02-day-card-component.md` - Individual day card with states
3. `03-infinite-scroll-timeline.md` - Timeline with fade-to-focus
4. `04-tiptap-editor.md` - Rich text editor setup
5. `05-calendar-heatmap.md` - Activity calendar widget
6. `06-sidebar-notes-list.md` - Today's notes list
7. `07-focus-mode.md` - Distraction-free toggle
8. `08-density-slider.md` - Layout density control
9. `09-keyboard-shortcuts.md` - Navigation shortcuts
10. `10-animations-polish.md` - Smooth transitions
11. `11-empty-states.md` - First-time user experience
12. `12-integration-testing.md` - Final integration

## Testing Checklist

- [ ] Day cards render with correct opacity/scale based on position
- [ ] Scrolling updates fade-to-focus effect smoothly
- [ ] Tiptap editor saves content automatically
- [ ] Calendar heat map shows accurate activity density
- [ ] Clicking calendar date scrolls to that day
- [ ] Today's notes list updates when new timestamps added
- [ ] Focus mode hides sidebar and centers editor
- [ ] Density slider changes spacing/sizing
- [ ] All keyboard shortcuts work correctly
- [ ] Scroll animations are smooth (800ms)
- [ ] Empty state shows for new users
- [ ] Past days are read-only or editable based on design choice
- [ ] Future days show dotted borders and placeholder state
- [ ] Data persists between app restarts

## Design Principles

1. **Today is King**: The current day should always be the most prominent
2. **Progressive Disclosure**: Fade past/future to reduce cognitive load
3. **Smooth Transitions**: All animations should feel natural (300-800ms)
4. **Data Preservation**: Auto-save aggressively, never lose user input
5. **Keyboard-First**: Power users should never need the mouse
6. **Clarity Over Cleverness**: Obvious interactions beat hidden features

## Notes

- This is NOT a mood tracker - no emotional state logging
- Each day can have multiple timestamped notes (like Reflect app)
- Heat map density is based on note count, not word count
- Editor should support basic formatting: bold, italic, links, lists
- Consider implementing virtual scrolling if performance issues arise
- Calendar should show 3 months at a time (past, current, next)

## Questions to Resolve During Implementation

1. Should past days be editable or read-only?
2. How many days to pre-render above/below viewport?
3. Should we support image attachments in notes?
4. Export functionality (PDF, Markdown)?
5. Search across all journal entries?

Proceed through each prompt file in order. Each prompt is designed to be executable independently by Claude Code.
