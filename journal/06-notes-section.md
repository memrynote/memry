# Memry Journal — Notes Section with Drawer

## Overview

Build the Notes section within the day card and the drawer panel that opens when clicking a note. The drawer slides over the right sidebar, maintaining the 3-column layout at all times. This provides quick access to notes without disrupting the journal writing flow.

## Notes Section Placement
```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                                ┃
┃   [Header]                                                     ┃
┃                                                                ┃
┃   [Calendar Events - collapsible]                              ┃
┃                                                                ┃
┃   [Overdue Tasks - collapsible]                                ┃
┃                                                                ┃
┃   ┌────────────────────────────────────────────────────────┐   ┃
┃   │                                                        │   ┃
┃   │   📝 Notes                                        (2)  │   ┃  ← This section
┃   │   ────────────────────────────────────────────────     │   ┃     Always visible
┃   │                                                        │   ┃
┃   │   [Note items...]                                      │   ┃
┃   │                                                        │   ┃
┃   └────────────────────────────────────────────────────────┘   ┃
┃                                                                ┃
┃   [Journal Editor - always visible]                            ┃
┃                                                                ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

## Layout Principle: Always 3 Columns
```
CRITICAL RULE: Never exceed 3 columns

┌────────────┬────────────────────────────────┬────────────────────┐
│            │                                │                    │
│    NAV     │         JOURNAL AREA           │   RIGHT SIDEBAR    │
│  SIDEBAR   │                                │   or NOTE DRAWER   │
│            │                                │                    │
│   ~200px   │           ~60%                 │       ~40%         │
│            │                                │                    │
└────────────┴────────────────────────────────┴────────────────────┘

The right section is EITHER:
- Right Sidebar (Calendar, AI Connections, Today's Notes)
- Note Drawer (when a note is open)

NEVER both at the same time.
```

## Notes Section Structure

### With Notes
```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   📝  Notes                                               (2)  │
│                                                                │
│   ──────────────────────────────────────────────────────────   │
│                                                                │
│   ┌──────────────────────────────────────────────────────────┐ │
│   │                                                          │ │
│   │   9:34 AM                                                │ │
│   │   📄  Meeting Notes                                  →   │ │
│   │       "Discussed the roadmap changes and timeline..."    │ │
│   │                                                          │ │
│   └──────────────────────────────────────────────────────────┘ │
│                                                                │
│   ┌──────────────────────────────────────────────────────────┐ │
│   │                                                          │ │
│   │   2:15 PM                                                │ │
│   │   📄  Feature Ideas                                  →   │ │
│   │       "New onboarding flow concept with progressive..."  │ │
│   │                                                          │ │
│   └──────────────────────────────────────────────────────────┘ │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Without Notes (Empty State)
```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   📝  Notes                                                    │
│                                                                │
│   ──────────────────────────────────────────────────────────   │
│                                                                │
│                                                                │
│                    No notes from this day                      │
│                                                                │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Empty state:
- Section header still shows (no count badge)
- Centered text: "No notes from this day"
- Subtle/secondary text color
```

## Note Item Structure
```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   9:34 AM                                                        │
│   📄  Meeting Notes                                          →   │
│       "Discussed the roadmap changes and timeline..."            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Layout breakdown:
┌──────────────────────────────────────────────────────────────────┐
│  [TIME]                                                          │
│  [ICON]  [NOTE TITLE]                                   [ARROW]  │
│          [PREVIEW SNIPPET]                                       │
└──────────────────────────────────────────────────────────────────┘

Elements:
- Time: "9:34 AM" - secondary color, small font (12px)
- Icon: 📄 or document icon
- Title: Note title - primary color, medium weight (14px, 500)
- Arrow: → indicates clickable, opens drawer
- Preview: First line snippet - secondary color, truncated (13px)
          Max 1 line with ellipsis

Spacing:
- Container padding: 12px
- Gap between time and title row: 4px
- Gap between title and preview: 4px
- Icon to title gap: 8px
```

### Note Item States
```
NORMAL:
┌──────────────────────────────────────────────────────────────────┐
│   9:34 AM                                                        │
│   📄  Meeting Notes                                          →   │
│       "Discussed the roadmap changes..."                         │
└──────────────────────────────────────────────────────────────────┘

HOVER:
┌──────────────────────────────────────────────────────────────────┐
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│▒  9:34 AM                                                      ▒│
│▒  📄  Meeting Notes                                          → ▒│
│▒      "Discussed the roadmap changes..."                       ▒│
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
└──────────────────────────────────────────────────────────────────┘

Properties:
- Background: Subtle highlight
- Cursor: pointer
- Arrow: More visible
- Transition: 150ms ease

ACTIVE (Currently open in drawer):
┌──────────────────────────────────────────────────────────────────┐
│████████████████████████████████████████████████████████████████████│
│██  9:34 AM                                                      ██│
│██  📄  Meeting Notes                                          → ██│
│██      "Discussed the roadmap changes..."                       ██│
│████████████████████████████████████████████████████████████████████│
└──────────────────────────────────────────────────────────────────┘

Properties:
- Background: Accent color (muted)
- Left border: 3px accent color
- Indicates this note is currently open in drawer
```

## Drawer Behavior

### Normal State (No Drawer)
```
┌────────────┬──────────────────────────────────────┬─────────────────────────┐
│            │                                      │                         │
│            │   December 9, 2025                   │   📅 December 2025      │
│    NAV     │   TUESDAY • Today                    │   ┌─────────────────┐   │
│  SIDEBAR   │                                      │   │ [Calendar Grid] │   │
│            │   📝 Notes                      (2)  │   └─────────────────┘   │
│            │   ┌────────────────────────────────┐ │                         │
│            │   │ 9:34 AM                        │ │   ⚡ AI Connections     │
│            │   │ 📄 Meeting Notes           →  │ │   [Connections...]      │
│            │   └────────────────────────────────┘ │                         │
│            │   ┌────────────────────────────────┐ │   📝 Today's Notes      │
│            │   │ 2:15 PM                        │ │   [Notes list...]       │
│            │   │ 📄 Feature Ideas           →  │ │                         │
│            │   └────────────────────────────────┘ │                         │
│            │                                      │                         │
│            │   ✏️ Journal                         │                         │
│            │   [Editor...]                        │                         │
│            │                                      │                         │
└────────────┴──────────────────────────────────────┴─────────────────────────┘

Right sidebar visible with all components
```

### Click Note → Drawer Opens
```
┌────────────┬──────────────────────────────────────┬─────────────────────────┐
│            │                                      │┃                       ┃│
│            │   December 9, 2025                   │┃  📄 Meeting Notes   ✕ ┃│
│    NAV     │   TUESDAY • Today                    │┃                       ┃│
│  SIDEBAR   │                                      │┃  ───────────────────  ┃│
│            │   📝 Notes                      (2)  │┃                       ┃│
│            │   ┌────────────────────────────────┐ │┃  Discussed the       ┃│
│            │   │ 9:34 AM                        │ │┃  roadmap changes     ┃│
│            │   │ 📄 Meeting Notes        [●]   │ │┃  with the team       ┃│
│            │   └────────────────────────────────┘ │┃  today. Sarah raised ┃│
│            │   ┌────────────────────────────────┐ │┃  some excellent      ┃│
│            │   │ 2:15 PM                        │ │┃  points about the    ┃│
│            │   │ 📄 Feature Ideas           →  │ │┃  timeline.           ┃│
│            │   └────────────────────────────────┘ │┃                       ┃│
│            │                                      │┃  Key decisions:       ┃│
│            │   ✏️ Journal                         │┃  • Timeline → Q2     ┃│
│            │   [Editor...]                        │┃  • New milestones    ┃│
│            │                                      │┃                       ┃│
│            │                                      │┃  ───────────────────  ┃│
│            │                                      │┃  B I U │ 🔗 📷 │ ↗  ┃│
│            │                                      │┃                       ┃│
└────────────┴──────────────────────────────────────┴┻───────────────────────┻┘
                                                     ↑
                                               DRAWER (40%)
                                               Slides over sidebar
                                               Sidebar is hidden behind

[●] = Indicates this note is open in drawer
```

## Drawer Animation

### Opening Animation
```
STEP 1: User clicks note item
        │
        ▼
STEP 2: Note item shows "active" state immediately
        │
        ▼
STEP 3: Drawer slides in from right edge

┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   JOURNAL AREA              │    RIGHT SIDEBAR                  │
│                             │                                   │
│                             │                    ┌─────────────┐│
│                             │                ←───│   DRAWER    ││
│                             │                    │  (sliding)  ││
│                             │                    └─────────────┘│
│                             │                                   │
└─────────────────────────────┴───────────────────────────────────┘

Animation:
- Duration: 250ms
- Easing: ease-out (cubic-bezier(0.33, 1, 0.68, 1))
- Drawer: translateX(100%) → translateX(0)
- Sidebar: Stays in place, drawer covers it
```

### Closing Animation
```
STEP 1: User clicks ✕ or outside drawer or presses Escape
        │
        ▼
STEP 2: Drawer slides out to right

┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   JOURNAL AREA              │    RIGHT SIDEBAR                  │
│                             │                                   │
│                             │    ┌─────────────┐                │
│                             │    │   DRAWER    │───▶            │
│                             │    │  (sliding)  │   (exits)      │
│                             │    └─────────────┘                │
│                             │                                   │
└─────────────────────────────┴───────────────────────────────────┘

STEP 3: Sidebar revealed underneath
        │
        ▼
STEP 4: Note item removes "active" state

Animation:
- Duration: 200ms
- Easing: ease-in (cubic-bezier(0.32, 0, 0.67, 0))
- Drawer: translateX(0) → translateX(100%)
```

## Drawer Structure
```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   📄  Meeting Notes                                    ↗    ✕   │
│                                                                 │
│   ─────────────────────────────────────────────────────────────│
│                                                                 │
│   ┌───────────────────────────────────────────────────────────┐ │
│   │                                                           │ │
│   │  Discussed the roadmap changes with the team today.       │ │
│   │  Sarah raised some excellent points about the timeline.   │ │
│   │                                                           │ │
│   │  Key decisions:                                           │ │
│   │  • Timeline shifted to Q2                                 │ │
│   │  • New milestones defined                                 │ │
│   │  • [[Project Alpha]] scope reduced                        │ │
│   │                                                           │ │
│   │  #work #meetings #roadmap                                 │ │
│   │                                                           │ │
│   │                                                           │ │
│   │                                                           │ │
│   │                                                           │ │
│   │                                                           │ │
│   │                                                           │ │
│   ├───────────────────────────────────────────────────────────┤ │
│   │  B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮                      │ │
│   └───────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Drawer Header
```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   📄  Meeting Notes                                    ↗    ✕   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Layout:
┌─────────────────────────────────────────────────────────────────┐
│  [ICON]  [NOTE TITLE]                           [EXPAND] [CLOSE]│
└─────────────────────────────────────────────────────────────────┘

Elements:
- Icon: 📄 or document icon (16px)
- Title: Note title, truncate if long (15px, 600 weight)
- Expand button: ↗ (opens note in full page)
- Close button: ✕ (closes drawer)

Spacing:
- Padding: 16px
- Gap between icon and title: 8px
- Buttons on right with 8px gap between them

Button tooltips:
- ↗ : "Open in full page"
- ✕ : "Close"
```

### Drawer Content (Note Editor)
```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  Discussed the roadmap changes with the team today.           │
│  Sarah raised some excellent points about the timeline.       │
│                                                               │
│  Key decisions:                                               │
│  • Timeline shifted to Q2                                     │
│  • New milestones defined                                     │
│  • [[Project Alpha]] scope reduced                            │
│                                                               │
│  #work #meetings #roadmap                                     │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│  B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮                          │
└───────────────────────────────────────────────────────────────┘

Properties:
- Full Tiptap editor (same as journal editor)
- Supports [[wiki-links]] and #tags
- All formatting options available
- Scrollable if content is long
- Editor fills available height (flex: 1)
- Toolbar at bottom
```

## Drawer Sizing
```
DRAWER WIDTH: 40% of viewport

┌────────────┬────────────────────────────────────┬──────────────────────────┐
│            │                                    │                          │
│    NAV     │         JOURNAL AREA               │        DRAWER            │
│  SIDEBAR   │                                    │                          │
│            │                                    │                          │
│   ~200px   │           ~60%                     │         40%              │
│   fixed    │         flexible                   │       of viewport        │
│            │                                    │                          │
└────────────┴────────────────────────────────────┴──────────────────────────┘

Calculations:
- Viewport: 1440px
- Nav sidebar: 200px
- Remaining: 1240px
- Drawer: 40% of 1440px = 576px
- Journal area: 1440px - 200px - 576px = 664px

Minimum drawer width: 360px
Maximum drawer width: 600px
```

## Close Methods
```
METHOD 1: Click ✕ button
┌───┐
│ ✕ │  → Drawer slides out, sidebar revealed
└───┘

METHOD 2: Press Escape key
[Esc]  → Drawer slides out, sidebar revealed

METHOD 3: Click outside drawer (on journal area)
┌──────────────────────────────────────┬─────────────────────────┐
│                                      │┃                       ┃│
│   Click here                         │┃      DRAWER           ┃│
│      ↓                               │┃                       ┃│
│   ████████                           │┃                       ┃│
│                                      │┃                       ┃│
└──────────────────────────────────────┴┻───────────────────────┻┘

→ Drawer slides out, sidebar revealed

METHOD 4: Click different note
┌────────────────────────────────────────┐
│   📝 Notes                             │
│   ┌──────────────────────────────────┐ │
│   │ Meeting Notes              [●]   │ │  ← Currently open
│   └──────────────────────────────────┘ │
│   ┌──────────────────────────────────┐ │
│   │ Feature Ideas               →    │ │  ← Click this
│   └──────────────────────────────────┘ │
└────────────────────────────────────────┘

→ Drawer content switches to Feature Ideas (no close/reopen animation)
```

## Switch Between Notes
```
Drawer showing "Meeting Notes"
User clicks "Feature Ideas" in notes list
        │
        ▼
Content transitions (drawer stays open):

┌────────────────────────────┐     ┌────────────────────────────┐
│ 📄 Meeting Notes      ↗ ✕ │     │ 📄 Feature Ideas      ↗ ✕ │
│ ────────────────────────── │ →   │ ────────────────────────── │
│                            │     │                            │
│ Meeting content...         │     │ Feature ideas content...   │
│                            │     │                            │
└────────────────────────────┘     └────────────────────────────┘

Animation:
- Crossfade: Old content fades out (100ms), new fades in (100ms)
- No drawer slide animation
- "Active" state moves to newly selected note item
```

## "Open in Full Page" Behavior
```
Click ↗ button in drawer header:
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ← Back to Journal                              Meeting Notes   │
│                                                                 │
│  ───────────────────────────────────────────────────────────────│
│                                                                 │
│                                                                 │
│  [Full page note editor]                                        │
│                                                                 │
│  Much more space for editing                                    │
│                                                                 │
│                                                                 │
│                                                                 │
│  ───────────────────────────────────────────────────────────────│
│  B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Behavior:
- Navigates away from Journal page
- Opens dedicated note page
- "Back to Journal" link to return
- For deep editing sessions
```

## Responsive Behavior

### Desktop (> 1200px)
```
┌────────────┬────────────────────────────────────┬──────────────────────────┐
│            │                                    │                          │
│    NAV     │         JOURNAL AREA               │        DRAWER (40%)      │
│  SIDEBAR   │                                    │                          │
│            │                                    │                          │
│   200px    │           flexible                 │        ~500px            │
│            │                                    │                          │
└────────────┴────────────────────────────────────┴──────────────────────────┘
```

### Tablet (768px - 1200px)
```
┌────────────┬──────────────────────────┬──────────────────────────────────────┐
│            │                          │                                      │
│    NAV     │      JOURNAL AREA        │           DRAWER (50%)               │
│  (icons)   │                          │                                      │
│            │                          │                                      │
│   60px     │        flexible          │           ~400px                     │
│            │                          │                                      │
└────────────┴──────────────────────────┴──────────────────────────────────────┘

- Nav sidebar collapses to icons
- Drawer takes 50% on tablet
```

### Mobile (< 768px)
```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  ← Back                                                    Meeting Notes     │
│                                                                              │
│  ────────────────────────────────────────────────────────────────────────────│
│                                                                              │
│                                                                              │
│  [Full screen note editor]                                                   │
│                                                                              │
│                                                                              │
│                                                                              │
│  ────────────────────────────────────────────────────────────────────────────│
│  B  I  U  │  🔗  📷  │  ⋮                                                    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

- Drawer becomes full screen
- Back button to return to journal
- Like opening a new page
```

## Keyboard Navigation
```
When drawer is open:

Tab         → Move focus within drawer (header buttons, editor)
Escape      → Close drawer, return focus to note list
Cmd/Ctrl+S  → Save note (if not auto-saved)

When note list is focused:

Enter       → Open selected note in drawer
Arrow Up/Down → Navigate between notes
```

## Accessibility
```
Drawer:
- role="dialog"
- aria-modal="true"
- aria-labelledby="drawer-title"
- Focus moves to drawer when opened
- Focus returns to trigger element when closed

Note items:
- role="button"
- aria-expanded="true" when drawer is open for this note
- aria-selected="true" for currently open note

Screen reader announcements:
- "Meeting Notes, note drawer opened"
- "Note drawer closed"

Close button:
- aria-label="Close note drawer"

Expand button:
- aria-label="Open note in full page"
```

## Component Hierarchy
```
JournalPage
├── NavSidebar
├── JournalArea
│   └── DayCard
│       └── NotesSection
│           ├── SectionHeader
│           │   ├── Icon (📝)
│           │   ├── Title ("Notes")
│           │   └── Count ((2))
│           │
│           ├── Separator
│           │
│           ├── NotesList (if notes.length > 0)
│           │   └── NoteItem (×n)
│           │       ├── Time
│           │       ├── Icon
│           │       ├── Title
│           │       ├── Preview
│           │       └── Arrow
│           │
│           └── EmptyState (if notes.length === 0)
│
├── RightSidebar (hidden when drawer is open)
│   ├── CalendarHeatmap
│   ├── AIConnections
│   └── TodaysNotes
│
└── NoteDrawer (when note is selected)
    ├── DrawerHeader
    │   ├── Icon
    │   ├── Title
    │   ├── ExpandButton
    │   └── CloseButton
    │
    ├── DrawerContent
    │   └── TiptapEditor
    │
    └── DrawerToolbar
```

## Data Structure
```typescript
interface Note {
  id: string;
  title: string;
  content: string;           // Rich text (HTML or JSON)
  createdAt: string;         // ISO timestamp
  updatedAt: string;         // ISO timestamp
  preview?: string;          // First ~60 chars for preview
}

interface NotesSectionProps {
  notes: Note[];
  activeNoteId?: string;     // Currently open in drawer
  onNoteClick: (noteId: string) => void;
}

interface NoteDrawerProps {
  note: Note;
  isOpen: boolean;
  onClose: () => void;
  onOpenFullPage: (noteId: string) => void;
  onContentChange: (content: string) => void;
}
```

## State Management
```typescript
// JournalPage component manages drawer state
const [drawerState, setDrawerState] = useState<{
  isOpen: boolean;
  noteId: string | null;
}>({
  isOpen: false,
  noteId: null
});

// Open drawer
function openDrawer(noteId: string) {
  setDrawerState({ isOpen: true, noteId });
}

// Close drawer
function closeDrawer() {
  setDrawerState({ isOpen: false, noteId: null });
}

// Switch note (drawer stays open)
function switchNote(noteId: string) {
  setDrawerState(prev => ({ ...prev, noteId }));
}

// Handle click outside
function handleJournalAreaClick() {
  if (drawerState.isOpen) {
    closeDrawer();
  }
}

// Handle escape key
useEffect(() => {
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && drawerState.isOpen) {
      closeDrawer();
    }
  }
  document.addEventListener('keydown', handleKeyDown);
  return () => document.removeEventListener('keydown', handleKeyDown);
}, [drawerState.isOpen]);
```

## Spacing Specifications
```
Notes Section:
├── Padding: 16px
├── Background: Subtle card background (optional)
├── Border-radius: 8px
│
├── Header
│   ├── Margin-bottom: 12px
│   ├── Icon size: 18px
│   ├── Title font: 14px, 500 weight
│   └── Count badge: 13px, secondary color
│
├── Separator
│   ├── Height: 1px
│   ├── Background: Border color
│   └── Margin-bottom: 12px
│
└── Note Items
    ├── Padding: 12px
    ├── Margin-bottom: 8px
    ├── Border-radius: 6px
    ├── Time font: 12px, secondary
    ├── Title font: 14px, 500 weight
    ├── Preview font: 13px, secondary
    └── Arrow: 16px, secondary (brighter on hover)


Note Drawer:
├── Width: 40% of viewport
├── Min-width: 360px
├── Max-width: 600px
├── Background: Card background
├── Border-left: 1px border color
├── Box-shadow: -4px 0 20px rgba(0,0,0,0.15)
│
├── Header
│   ├── Padding: 16px
│   ├── Border-bottom: 1px
│   ├── Title font: 15px, 600 weight
│   └── Button size: 28px × 28px
│
├── Content
│   ├── Padding: 16px
│   ├── Flex: 1 (fills available space)
│   └── Overflow-y: auto
│
└── Toolbar
    ├── Padding: 8px 12px
    ├── Border-top: 1px
    └── Sticky at bottom
```

## CSS Implementation
```css
/* Notes Section */
.notes-section {
  padding: 16px;
}

.note-item {
  padding: 12px;
  margin-bottom: 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 150ms ease;
}

.note-item:hover {
  background-color: var(--hover-bg);
}

.note-item.active {
  background-color: var(--accent-bg-muted);
  border-left: 3px solid var(--accent-color);
}

/* Note Drawer */
.note-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 40vw;
  min-width: 360px;
  max-width: 600px;
  background: var(--card-bg);
  border-left: 1px solid var(--border-color);
  box-shadow: -4px 0 20px rgba(0, 0, 0, 0.15);
  z-index: 100;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 250ms ease-out;
}

.note-drawer.open {
  transform: translateX(0);
}

.note-drawer-header {
  display: flex;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.note-drawer-title {
  flex: 1;
  font-size: 15px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.note-drawer-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.note-drawer-toolbar {
  padding: 8px 12px;
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
}

/* Overlay for click outside (optional) */
.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 99;
  /* transparent, just for capturing clicks */
}
```

## Expected Output

After implementing this prompt:
1. Notes section displays list of notes with time, title, preview
2. Empty state shows when no notes exist
3. Clicking note opens drawer (slides from right)
4. Drawer covers right sidebar (40% width)
5. Drawer shows note content in editable Tiptap editor
6. Close via ✕ button, Escape key, or click outside
7. Expand button opens note in full page
8. Active note is highlighted in list
9. Switching notes changes drawer content (no reopen animation)
10. Responsive behavior on different screen sizes
11. Proper accessibility attributes
12. Smooth slide animations

## User Scenarios Addressed

| User Type | Need | Solution |
|-----------|------|----------|
| Quick Capture | Glance at notes while journaling | Drawer shows note, journal stays visible |
| Cross-Referencer | Copy from note to journal | Both visible side by side |
| Light Editor | Fix a typo quickly | Edit in drawer, close when done |
| Deep Worker | Full editing session | "Open in full page" escape hatch |