# Memry Journal — Notes Section

## Overview

Build the Notes section within the day card and the split view sliding panel that opens when clicking a note. Unlike the collapsible sections, Notes is always visible. Clicking a note opens it in a sliding panel alongside the journal, maintaining context.

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
- No action buttons (notes created elsewhere in app)
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
- Arrow: → indicates clickable, opens panel
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
- Arrow: May become more visible/colored
- Transition: 150ms ease

ACTIVE (Currently open in panel):
┌──────────────────────────────────────────────────────────────────┐
│████████████████████████████████████████████████████████████████████│
│██  9:34 AM                                                      ██│
│██  📄  Meeting Notes                                          → ██│
│██      "Discussed the roadmap changes..."                       ██│
│████████████████████████████████████████████████████████████████████│
└──────────────────────────────────────────────────────────────────┘

Properties:
- Background: Accent color (muted) or strong highlight
- Left border: 3px accent color (optional)
- Indicates this note is currently open in panel
```

## Split View Panel

When a note is clicked, a sliding panel opens from the right, creating a split view.

### Before Click (Normal View)
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│           SCROLL AREA (100%)                        │     SIDEBAR           │
│                                                     │                       │
│    ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓   │                       │
│    ┃  December 9                                ┃   │                       │
│    ┃  ────────────────────────────────────────  ┃   │                       │
│    ┃                                            ┃   │                       │
│    ┃  [Sections...]                             ┃   │                       │
│    ┃                                            ┃   │                       │
│    ┃  📝 Notes                                  ┃   │                       │
│    ┃  ┌──────────────────────────────────────┐  ┃   │                       │
│    ┃  │ 9:34 AM                              │  ┃   │                       │
│    ┃  │ 📄 Meeting Notes                  →  │←─╋───┼─── User clicks       │
│    ┃  └──────────────────────────────────────┘  ┃   │                       │
│    ┃                                            ┃   │                       │
│    ┃  [Journal Editor]                          ┃   │                       │
│    ┃                                            ┃   │                       │
│    ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛   │                       │
│                                                     │                       │
└─────────────────────────────────────────────────────┴───────────────────────┘
```

### After Click (Split View)
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│      SCROLL AREA (55%)           │     NOTE PANEL (45%)     │   SIDEBAR    │
│                                  │                          │   (hidden    │
│    ┏━━━━━━━━━━━━━━━━━━━━━━━━━┓   │  ┌──────────────────────┐│    or       │
│    ┃  December 9             ┃   │  │ 📄 Meeting Notes  ✕ ↗││   behind)   │
│    ┃  ──────────────────────  ┃   │  │ ────────────────────││             │
│    ┃                         ┃   │  │                      ││             │
│    ┃  [Collapsed sections]   ┃   │  │ Discussed the        ││             │
│    ┃                         ┃   │  │ roadmap changes      ││             │
│    ┃  📝 Notes               ┃   │  │ with the team today. ││             │
│    ┃  ┌───────────────────┐  ┃   │  │                      ││             │
│    ┃  │ 9:34 AM           │  ┃   │  │ Key decisions:       ││             │
│    ┃  │ 📄 Meeting Notes █│  ┃   │  │ • Timeline shifted   ││             │
│    ┃  └───────────────────┘  ┃   │  │ • New milestones     ││             │
│    ┃                         ┃   │  │                      ││             │
│    ┃  [Journal Editor]       ┃   │  │ [[Project Alpha]]    ││             │
│    ┃                         ┃   │  │                      ││             │
│    ┗━━━━━━━━━━━━━━━━━━━━━━━━━┛   │  │ ────────────────────││             │
│                                  │  │ B I U │ 🔗 📷 │ ⋮   ││             │
│                                  │  └──────────────────────┘│             │
│                                  │                          │             │
│                                  │  [↗️ Open full page]     │             │
│                                  │                          │             │
└──────────────────────────────────┴──────────────────────────┴─────────────┘

Layout changes:
- Scroll area shrinks from ~65% to ~55%
- Note panel takes ~45% of scroll area space (or fixed width ~400px)
- Sidebar may hide or stay (depending on screen width)
- Day card content adjusts to narrower width
```

## Panel Animation

### Opening Animation
```
STEP 1: User clicks note item
        │
        ▼
STEP 2: Note item highlights as "active"
        │
        ▼
STEP 3: Panel slides in from right edge

        ┌──────────────────────────┐
        │                          │
        │  SCROLL AREA             │ ←─── Panel slides
        │                          │      from here
        │                          │         │
        │                          │         │
        │                          │    ┌────┴─────┐
        │                          │←───│  PANEL   │
        │                          │    │ (sliding)│
        │                          │    └──────────┘
        │                          │
        └──────────────────────────┘

STEP 4: Scroll area shrinks simultaneously
        │
        ▼
STEP 5: Final split view state

Animation timing:
- Duration: 300ms
- Easing: ease-out (cubic-bezier(0.33, 1, 0.68, 1))
- Panel: translateX(100%) → translateX(0)
- Scroll area: width 100% → 55% (simultaneous)
```

### Closing Animation
```
STEP 1: User clicks ✕ or clicks outside panel
        │
        ▼
STEP 2: Panel slides out to right

        ┌──────────────────────────┐
        │                          │    ┌──────────┐
        │  SCROLL AREA             │───▶│  PANEL   │
        │  (expanding)             │    │ (sliding)│
        │                          │    └────┬─────┘
        │                          │         │
        │                          │         ▼
        │                          │      (exits)
        │                          │
        └──────────────────────────┘

STEP 3: Scroll area expands back to full width
        │
        ▼
STEP 4: Note item removes "active" state

Animation timing:
- Duration: 250ms
- Easing: ease-in (cubic-bezier(0.32, 0, 0.67, 0))
- Panel: translateX(0) → translateX(100%)
- Scroll area: width 55% → 100% (simultaneous)
```

## Panel Structure
```
┌──────────────────────────────────────────────────────┐
│                                                      │
│   📄  Meeting Notes                          ✕   ↗   │  ← Panel Header
│                                                      │
│   ────────────────────────────────────────────────   │
│                                                      │
│   ┌────────────────────────────────────────────────┐ │
│   │                                                │ │
│   │  Discussed the roadmap changes with the team   │ │
│   │  today. Sarah raised some excellent points     │ │
│   │  about the timeline.                           │ │
│   │                                                │ │  ← Note Content
│   │  Key decisions:                                │ │     (Tiptap Editor)
│   │  • Timeline shifted to Q2                      │ │
│   │  • New milestones defined                      │ │
│   │  • [[Project Alpha]] scope reduced             │ │
│   │                                                │ │
│   │  #work #meetings #roadmap                      │ │
│   │                                                │ │
│   ├────────────────────────────────────────────────┤ │
│   │  B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮          │ │  ← Toolbar
│   └────────────────────────────────────────────────┘ │
│                                                      │
│   ────────────────────────────────────────────────   │
│                                                      │
│   ↗️  Open in full page                              │  ← Footer action
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Panel Header
```
┌──────────────────────────────────────────────────────┐
│                                                      │
│   📄  Meeting Notes                          ✕   ↗   │
│                                                      │
└──────────────────────────────────────────────────────┘

Layout:
┌──────────────────────────────────────────────────────┐
│  [ICON]  [NOTE TITLE]                    [CLOSE] [EXPAND]│
└──────────────────────────────────────────────────────┘

Elements:
- Icon: 📄 or document icon (16px)
- Title: Note title, truncate if long (14px, 600 weight)
- Close button: ✕ (closes panel, returns to normal view)
- Expand button: ↗ (opens note in full page)

Spacing:
- Padding: 16px
- Gap between icon and title: 8px
- Buttons on right with 8px gap between them
```

### Panel Content (Note Editor)
```
┌────────────────────────────────────────────────────┐
│                                                    │
│  Discussed the roadmap changes with the team       │
│  today. Sarah raised some excellent points         │
│  about the timeline.                               │
│                                                    │
│  Key decisions:                                    │
│  • Timeline shifted to Q2                          │
│  • New milestones defined                          │
│  • [[Project Alpha]] scope reduced                 │
│                                                    │
│  #work #meetings #roadmap                          │
│                                                    │
├────────────────────────────────────────────────────┤
│  B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮              │
└────────────────────────────────────────────────────┘

Properties:
- Full Tiptap editor (same as journal editor)
- Supports [[wiki-links]] and #tags
- All formatting options available
- Scrollable if content is long
- Min-height to fill panel space
```

### Panel Footer
```
┌──────────────────────────────────────────────────────┐
│                                                      │
│   ↗️  Open in full page                              │
│                                                      │
└──────────────────────────────────────────────────────┘

Elements:
- Link/button to open note in full page view
- Useful when user wants more space to edit

Interaction:
- Click: Navigates to dedicated note page
- Panel closes, user leaves journal view
```

## Responsive Behavior

### Wide Screen (> 1400px)
```
┌────────────────────────────────────┬────────────────────┬──────────────────┐
│                                    │                    │                  │
│     SCROLL AREA (50%)              │   PANEL (30%)      │  SIDEBAR (20%)   │
│                                    │                    │                  │
│     Day cards visible              │   Note editor      │  Calendar, etc.  │
│                                    │                    │                  │
└────────────────────────────────────┴────────────────────┴──────────────────┘

All three sections visible simultaneously
```

### Medium Screen (1024px - 1400px)
```
┌────────────────────────────────────┬────────────────────────────────────────┐
│                                    │                                        │
│     SCROLL AREA (55%)              │            PANEL (45%)                 │
│                                    │                                        │
│     Day cards visible              │            Note editor                 │
│                                    │                                        │
└────────────────────────────────────┴────────────────────────────────────────┘

Sidebar hidden when panel is open (slides out or overlays)
```

### Narrow Screen (768px - 1024px)
```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│                              PANEL (100%)                                  │
│                                                                            │
│                              Note editor                                   │
│                              Full width overlay                            │
│                                                                            │
│                              [← Back to Journal]                           │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

Panel becomes full-width overlay with back button
```

### Mobile (< 768px)
```
┌──────────────────────────────────┐
│                                  │
│  ← Back          Meeting Notes   │  ← Header with back
│                                  │
│  ────────────────────────────    │
│                                  │
│  [Full screen note editor]       │
│                                  │
│                                  │
│                                  │
│  ────────────────────────────    │
│  B I U │ 🔗 📷 │ ⋮              │
│                                  │
└──────────────────────────────────┘

Full screen note view, replaces journal entirely
Back button returns to journal
```

## Panel Interactions

### Close Panel Methods
```
1. Click ✕ button in panel header
   → Panel slides out, normal view restored

2. Press Escape key
   → Panel slides out, normal view restored

3. Click outside panel (on scroll area)
   → Optional: Can close panel or keep it open
   → Recommendation: Keep panel open (user might click journal to edit)

4. Click different note
   → Current panel content changes to new note
   → No close/reopen animation, just content swap

5. Scroll away from current day
   → Panel stays open with same note
   → OR panel closes (design decision)
   → Recommendation: Panel closes when scrolling to different day
```

### Switch Between Notes
```
Panel showing "Meeting Notes"
User clicks "Feature Ideas" in notes list
        │
        ▼
Content transitions (no panel animation):

┌────────────────────────────┐     ┌────────────────────────────┐
│ 📄 Meeting Notes      ✕ ↗ │     │ 📄 Feature Ideas      ✕ ↗ │
│ ────────────────────────── │ →   │ ────────────────────────── │
│                            │     │                            │
│ Meeting content...         │     │ Feature ideas content...   │
│                            │     │                            │
└────────────────────────────┘     └────────────────────────────┘

Animation:
- Crossfade: Old content fades out (150ms), new fades in (150ms)
- OR instant swap (simpler)
- "Active" state moves to newly selected note item
```

## Keyboard Navigation
```
When panel is open:

Tab         → Move focus within panel (header buttons, editor)
Escape      → Close panel, return focus to note list
Cmd/Ctrl+S  → Save note (if not auto-saved)

When note list is focused:

Enter       → Open selected note in panel
Arrow Up/Down → Navigate between notes
```

## Accessibility
```
Panel:
- role="dialog" or role="complementary"
- aria-labelledby="panel-title"
- Focus trapped within panel when open (optional)
- Close button: aria-label="Close note panel"
- Expand button: aria-label="Open note in full page"

Note items:
- role="button" or role="listitem" with click handler
- aria-selected="true" for currently open note
- aria-expanded="true" when panel is showing this note

Screen reader announcements:
- "Meeting Notes, note panel opened"
- "Note panel closed"
```

## Component Hierarchy
```
NotesSection
├── SectionHeader
│   ├── Icon (📝)
│   ├── Title ("Notes")
│   └── Count ((2))
│
├── Separator
│
├── NotesList (if notes.length > 0)
│   └── NoteItem (×n)
│       ├── Time
│       ├── Icon
│       ├── Title
│       ├── Preview
│       └── Arrow
│
└── EmptyState (if notes.length === 0)
    └── "No notes from this day"


NotePanel (separate component, portal or sibling)
├── PanelHeader
│   ├── Icon
│   ├── Title
│   ├── CloseButton
│   └── ExpandButton
│
├── PanelContent
│   └── TiptapEditor
│
└── PanelFooter
    └── OpenFullPageLink
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
  onNoteClick: (noteId: string) => void;
  activeNoteId?: string;     // Currently open in panel
}

interface NotePanelProps {
  note: Note;
  isOpen: boolean;
  onClose: () => void;
  onOpenFullPage: (noteId: string) => void;
  onContentChange: (content: string) => void;
}
```

## State Management
```typescript
// Parent component (JournalPage or DayCard) manages:
{
  // Panel state
  isPanelOpen: boolean;
  activeNoteId: string | null;

  // Actions
  openNotePanel: (noteId: string) => void;
  closeNotePanel: () => void;
  switchNote: (noteId: string) => void;
}

// Open panel
function openNotePanel(noteId: string) {
  setActiveNoteId(noteId);
  setIsPanelOpen(true);
}

// Close panel
function closeNotePanel() {
  setIsPanelOpen(false);
  // Optional: delay clearing activeNoteId until animation completes
  setTimeout(() => setActiveNoteId(null), 300);
}

// Switch note (panel already open)
function switchNote(noteId: string) {
  setActiveNoteId(noteId);
  // No change to isPanelOpen
}
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


Note Panel:
├── Width: 400px fixed or 45% flexible
├── Min-width: 320px
├── Max-width: 500px
├── Background: Card background
├── Border-left: 1px border color
├── Box-shadow: -4px 0 12px rgba(0,0,0,0.1)
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
└── Footer
    ├── Padding: 12px 16px
    ├── Border-top: 1px
    └── Link font: 13px, accent color
```

## Empty State Details
```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   📝  Notes                                                    │
│                                                                │
│   ──────────────────────────────────────────────────────────   │
│                                                                │
│                                                                │
│                         📄                                     │
│                                                                │
│               No notes from this day                           │
│                                                                │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Elements:
- Faded document icon (optional)
- Text: "No notes from this day"
- Secondary/muted text color
- Vertically centered in section
- Min-height to prevent section from being too short (~80px)
```

## Expected Output

After implementing this prompt:
1. Notes section displays list of notes with time, title, preview
2. Empty state shows when no notes exist
3. Clicking note opens split view panel
4. Panel slides in from right with animation
5. Scroll area shrinks to accommodate panel
6. Panel shows note content in editable Tiptap editor
7. Close button closes panel with animation
8. Expand button opens note in full page
9. Active note is highlighted in list
10. Switching notes changes panel content
11. Escape key closes panel
12. Responsive behavior on different screen sizes
13. Proper accessibility attributes

## Do Not Include Yet

- Full page note view/route
- Note creation from this section
- Tiptap editor implementation details (Prompt 07)
- Wiki-links and tags functionality (Prompt 11)

Focus on the section structure and split view panel behavior.

Implementation Notes
TechniqueWhyCSS transform for panelHardware-accelerated animationFlex layout for splitEasy responsive resizingPortal for panelAvoid z-index issuesFocus trapAccessibility for modal-like panelDebounced auto-saveDon't lose edits
Expected Outcome
After implementing this prompt, you should have:

Working notes list within day card
Empty state for days without notes
Split view panel that slides in from right
Smooth open/close animations
Active note highlighting
Close and expand buttons
Responsive behavior