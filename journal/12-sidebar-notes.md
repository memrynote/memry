# Memry Journal — Today's Notes Section

## Overview

Build the Today's Notes section for the right sidebar. This component displays a timestamped list of all notes created on the current day, providing quick access to recent work. It complements the AI Connections panel by showing explicit note activity rather than semantic relationships.

## Section Placement
```
┌───────────────────────────────────────┐
│                                       │
│           RIGHT SIDEBAR               │
│                                       │
│   ┌───────────────────────────────┐   │
│   │      📅 Calendar Heatmap      │   │
│   └───────────────────────────────┘   │
│                                       │
│   ┌───────────────────────────────┐   │
│   │      ⚡ AI Connections        │   │
│   └───────────────────────────────┘   │
│                                       │
│   ┌───────────────────────────────┐   │
│   │                               │   │
│   │      📝 Today's Notes         │   │  ← This component
│   │                               │   │
│   └───────────────────────────────┘   │
│                                       │
└───────────────────────────────────────┘
```

## Section States

### Empty State (No Notes Today)
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   📝  Today's Notes                                 │
│                                                     │
│   ─────────────────────────────────────────────────│
│                                                     │
│                                                     │
│                       📄                            │
│                                                     │
│              No notes created today                 │
│                                                     │
│              [+ Create Note]                        │
│                                                     │
│                                                     │
└─────────────────────────────────────────────────────┘

Elements:
- Decorative icon (📄 or empty state illustration)
- Message: "No notes created today"
- Optional CTA: "+ Create Note" button
- Encouraging, not discouraging
```

### With Notes (Active State)
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   📝  Today's Notes                           (5)   │
│                                                     │
│   ─────────────────────────────────────────────────│
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │                                               │ │
│   │   2:34 PM                                     │ │
│   │   📄  Meeting Notes - Design Review      →   │ │
│   │                                               │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │                                               │ │
│   │   11:15 AM                                    │ │
│   │   📄  Quick Ideas                        →   │ │
│   │                                               │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │                                               │ │
│   │   9:47 AM                                     │ │
│   │   📄  Sprint Planning Notes              →   │ │
│   │                                               │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│   + 2 more                                          │
│                                                     │
└─────────────────────────────────────────────────────┘

Notes ordered by creation time (newest first)
```

### Single Note State
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   📝  Today's Notes                           (1)   │
│                                                     │
│   ─────────────────────────────────────────────────│
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │                                               │ │
│   │   9:47 AM                                     │ │
│   │   📄  Sprint Planning Notes              →   │ │
│   │                                               │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
└─────────────────────────────────────────────────────┘

No expand button needed for single note
```

## Note Item Structure

### Standard Note Item
```
┌───────────────────────────────────────────────────────┐
│                                                       │
│   2:34 PM                                             │
│   📄  Meeting Notes - Design Review              →   │
│                                                       │
└───────────────────────────────────────────────────────┘

Layout breakdown:
┌───────────────────────────────────────────────────────┐
│  [TIME]                                               │
│  [ICON]  [NOTE TITLE]                        [ARROW]  │
└───────────────────────────────────────────────────────┘

Elements:
- Time: "2:34 PM" - creation time, secondary color, small font
- Icon: 📄 (document icon)
- Title: Note title, truncated if too long
- Arrow: → indicates clickable, opens note
```

### Note Item with Folder/Location
```
┌───────────────────────────────────────────────────────┐
│                                                       │
│   2:34 PM                                             │
│   📄  Meeting Notes - Design Review              →   │
│       📁 Work / Meetings                              │
│                                                       │
└───────────────────────────────────────────────────────┘

Optional: Show folder path
- Smaller font, tertiary color
- Helps distinguish notes with similar names
- Can be hidden to save space
```

### Note Item with Preview
```
┌───────────────────────────────────────────────────────┐
│                                                       │
│   2:34 PM                                             │
│   📄  Meeting Notes - Design Review              →   │
│       "Reviewed the new dashboard designs..."        │
│                                                       │
└───────────────────────────────────────────────────────┘

Optional: Show first line preview
- Truncated to single line
- Secondary color
- Provides context
```

### Minimal Note Item (Recommended)
```
┌───────────────────────────────────────────────────────┐
│                                                       │
│   2:34 PM                                             │
│   📄  Meeting Notes - Design Review              →   │
│                                                       │
└───────────────────────────────────────────────────────┘

Cleanest version:
- Time + Title only
- Most space-efficient
- Works well in sidebar width
```

## Section Header

### Standard Header
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   📝  Today's Notes                           (5)   │
│                                                     │
└─────────────────────────────────────────────────────┘

Elements:
- Icon: 📝 (memo/note emoji) or custom icon
- Title: "Today's Notes"
- Count badge: (5) - number of notes created today
```

### Header with Create Button
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   📝  Today's Notes                      +    (5)   │
│                                          ↑          │
└──────────────────────────────────────────┴──────────┘
                                           │
                                     Quick create button

Click +:
- Creates new note
- Opens note in panel or new page
- Pre-fills today's date context
```

### Header States
```
NORMAL:
┌─────────────────────────────────────────────────────┐
│   📝  Today's Notes                           (5)   │
└─────────────────────────────────────────────────────┘

LOADING (rare, on initial load):
┌─────────────────────────────────────────────────────┐
│   📝  Today's Notes                          ◠◡◠    │
└─────────────────────────────────────────────────────┘

EMPTY:
┌─────────────────────────────────────────────────────┐
│   📝  Today's Notes                                 │
└─────────────────────────────────────────────────────┘
(No count badge when empty)
```

## Interaction States

### Normal State
```
┌───────────────────────────────────────────────────────┐
│                                                       │
│   2:34 PM                                             │
│   📄  Meeting Notes - Design Review              →   │
│                                                       │
└───────────────────────────────────────────────────────┘

Properties:
- Background: Transparent or subtle card bg
- Cursor: Pointer
- Arrow: Secondary color
```

### Hover State
```
┌───────────────────────────────────────────────────────┐
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│▒                                                     ▒│
│▒  2:34 PM                                            ▒│
│▒  📄  Meeting Notes - Design Review              →   ▒│
│▒                                                     ▒│
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
└───────────────────────────────────────────────────────┘

Properties:
- Background: Subtle highlight
- Arrow: More prominent (primary color)
- Transition: 150ms ease
```

### Active State (Note Currently Open)
```
┌───────────────────────────────────────────────────────┐
│███████████████████████████████████████████████████████│
│██                                                   ██│
│██  2:34 PM                                          ██│
│██  📄  Meeting Notes - Design Review            →   ██│
│██                                                   ██│
│███████████████████████████████████████████████████████│
└───────────────────────────────────────────────────────┘

Properties:
- Background: Accent color (muted)
- Left border: 3px accent (optional)
- Indicates this note is open in panel
```

## Click Behavior

### Primary Click
```
Click on note item:
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│      SCROLL AREA (55%)           │     NOTE PANEL (45%)                     │
│                                  │                                          │
│    [Journal content...]          │  ┌──────────────────────────────────┐    │
│                                  │  │ 📄 Meeting Notes - Design Review │    │
│                                  │  │ ─────────────────────────────────│    │
│                                  │  │                                  │    │
│                                  │  │ [Note content...]                │    │
│                                  │  │                                  │    │
│                                  │  └──────────────────────────────────┘    │
│                                  │                                          │
└──────────────────────────────────┴──────────────────────────────────────────┘

Behavior:
- Opens note in split view panel (same as Notes section click)
- Panel slides in from right
- Note item shows "active" state
```

### Secondary Click (Cmd/Ctrl + Click)
```
Cmd/Ctrl + Click:
        │
        ▼
Opens note in new page/tab (full page view)
Does not use split panel
```

### Context Menu (Right Click)
```
Right-click on note item:

┌───────────────────────────────────────────────────────┐
│   2:34 PM                                             │
│   📄  Meeting Notes - Design Review              →   │
└───────────────────────────────────────────────────────┘
                    │
                    ▼
        ┌─────────────────────────────┐
        │                             │
        │  📂 Open                    │
        │  📂 Open in New Tab         │
        │  ─────────────────────────  │
        │  📋 Copy Link               │
        │  ─────────────────────────  │
        │  📁 Move to Folder...       │
        │  🏷️ Add Tags...             │
        │  ─────────────────────────  │
        │  🗑️ Delete                  │
        │                             │
        └─────────────────────────────┘

Context menu options for quick actions
```

## Time Display Format

### Time Formatting
```
CREATED TODAY:
- Show time only
- "2:34 PM"
- "9:47 AM"
- "11:15 AM"

12-HOUR FORMAT (US default):
"2:34 PM"

24-HOUR FORMAT (option):
"14:34"

RELATIVE TIME (alternative):
"2 hours ago"
"Just now"
"This morning"
```

### Time Grouping (Optional Enhancement)
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   📝  Today's Notes                           (5)   │
│                                                     │
│   ─────────────────────────────────────────────────│
│                                                     │
│   This Afternoon                                    │
│   ─────────────────────────────────────────────────│
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │  2:34 PM                                      │ │
│   │  📄  Meeting Notes - Design Review        →  │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│   This Morning                                      │
│   ─────────────────────────────────────────────────│
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │  11:15 AM                                     │ │
│   │  📄  Quick Ideas                          →  │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │  9:47 AM                                      │ │
│   │  📄  Sprint Planning Notes                →  │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
└─────────────────────────────────────────────────────┘

Groups:
- "Just Now" (< 5 minutes)
- "This Hour"
- "This Morning" / "This Afternoon" / "This Evening"

Optional: May add complexity, simple list often sufficient
```

## Overflow Handling

### Max Visible Items
```
Show maximum 3-4 notes by default:

┌─────────────────────────────────────────────────────┐
│   📝  Today's Notes                           (6)   │
│   ─────────────────────────────────────────────────│
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │  2:34 PM                                      │ │
│   │  📄  Meeting Notes - Design Review        →  │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │  11:15 AM                                     │ │
│   │  📄  Quick Ideas                          →  │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │  9:47 AM                                      │ │
│   │  📄  Sprint Planning Notes                →  │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│   ┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐ │
│   ╎                                               ╎ │
│   ╎   + 3 more notes                              ╎ │
│   ╎                                               ╎ │
│   └─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘ │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Expanded View
```
After clicking "+ 3 more notes":

┌─────────────────────────────────────────────────────┐
│   📝  Today's Notes                           (6)   │
│   ─────────────────────────────────────────────────│
│                                                     │
│   [Note 1 - 2:34 PM]                                │
│                                                     │
│   [Note 2 - 11:15 AM]                               │
│                                                     │
│   [Note 3 - 9:47 AM]                                │
│                                                     │
│   [Note 4 - 9:30 AM]                                │
│                                                     │
│   [Note 5 - 9:15 AM]                                │
│                                                     │
│   [Note 6 - 8:45 AM]                                │
│                                                     │
│   ─────────────────────────────────────────────────│
│                                                     │
│   Show less ⌃                                       │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Scrollable Alternative
```
If many notes, make section scrollable:

┌─────────────────────────────────────────────────────┐
│   📝  Today's Notes                           (8)   │
│   ─────────────────────────────────────────────────│
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │  [Note 1]                                     │ │
│   │                                               │ │
│   │  [Note 2]                                     │ │
│   │                                               │▲│
│   │  [Note 3]                                     │█│
│   │                                               │█│
│   │  [Note 4]                                     │▼│
│   └───────────────────────────────────────────────┘ │
│                                                     │
└─────────────────────────────────────────────────────┘

Max-height: ~250px
Overflow-y: auto
Subtle scrollbar
```

## Real-Time Updates

### New Note Created
```
When user creates a new note:

BEFORE:
┌─────────────────────────────────────────────────────┐
│   📝  Today's Notes                           (2)   │
│   ─────────────────────────────────────────────────│
│                                                     │
│   [Note 1 - 9:47 AM]                                │
│   [Note 2 - 8:30 AM]                                │
│                                                     │
└─────────────────────────────────────────────────────┘

        │
        │  User creates new note at 2:34 PM
        ▼

ANIMATION:
┌─────────────────────────────────────────────────────┐
│   📝  Today's Notes                           (3)   │  ← Count updates
│   ─────────────────────────────────────────────────│
│                                                     │
│   ┌───────────────────────────────────────────────┐ │
│   │  (sliding in from top)                        │ │
│   │  2:34 PM                                      │ │  ← New note slides in
│   │  📄  New Note                             →  │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│   [Note 1 - 9:47 AM]  (shifts down)                 │
│   [Note 2 - 8:30 AM]  (shifts down)                 │
│                                                     │
└─────────────────────────────────────────────────────┘

Animation:
- New item slides in from top (200ms)
- Existing items shift down (200ms)
- Count badge updates
- Brief highlight on new item (optional)
```

### Note Deleted
```
When user deletes a note:

┌─────────────────────────────────────────────────────┐
│   📝  Today's Notes                           (3)   │
│   ─────────────────────────────────────────────────│
│                                                     │
│   [Note 1 - 2:34 PM]  ← User deletes this          │
│   [Note 2 - 9:47 AM]                                │
│   [Note 3 - 8:30 AM]                                │
│                                                     │
└─────────────────────────────────────────────────────┘

        │
        │  Note deleted
        ▼

┌─────────────────────────────────────────────────────┐
│   📝  Today's Notes                           (2)   │  ← Count updates
│   ─────────────────────────────────────────────────│
│                                                     │
│   [Note 2 - 9:47 AM]  (slides up)                   │
│   [Note 3 - 8:30 AM]  (slides up)                   │
│                                                     │
└─────────────────────────────────────────────────────┘

Animation:
- Deleted item fades out (150ms)
- Remaining items slide up (200ms)
- Count badge updates
```

### Note Renamed
```
When user renames a note:

┌───────────────────────────────────────────────────────┐
│  2:34 PM                                              │
│  📄  Meeting Notes - Design Review               →   │
└───────────────────────────────────────────────────────┘

        │
        │  User renames to "Design Review - Dec 9"
        ▼

┌───────────────────────────────────────────────────────┐
│  2:34 PM                                              │
│  📄  Design Review - Dec 9                       →   │
└───────────────────────────────────────────────────────┘

Animation:
- Title crossfades (150ms)
- Position unchanged (still sorted by creation time)
```

## "Create Note" Functionality

### Create Button in Header
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   📝  Today's Notes                      +    (3)   │
│                                          ↑          │
└──────────────────────────────────────────┴──────────┘

Click + button:
1. Creates new untitled note
2. Opens note in split panel
3. Focuses on title for immediate editing
4. Note appears in list
```

### Create Button in Empty State
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   📝  Today's Notes                                 │
│                                                     │
│   ─────────────────────────────────────────────────│
│                                                     │
│                                                     │
│                       📄                            │
│                                                     │
│              No notes created today                 │
│                                                     │
│            ┌─────────────────────┐                  │
│            │   + Create Note     │                  │
│            └─────────────────────┘                  │
│                                                     │
│                                                     │
└─────────────────────────────────────────────────────┘

Prominent CTA when empty
Encourages note creation
```

### Quick Create Flow
```
STEP 1: Click + Create Note
        │
        ▼
STEP 2: New note created with timestamp title

┌───────────────────────────────────────────────────────┐
│  Just now                                             │
│  📄  Note - Dec 9, 2024 2:45 PM                  →   │
└───────────────────────────────────────────────────────┘
        │
        ▼
STEP 3: Split panel opens with note

┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  📄 Note - Dec 9, 2024 2:45 PM                        ✕   ↗   │
│                                                                │
│  ──────────────────────────────────────────────────────────────│
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                                                          │  │
│  │  |  ← Cursor ready for typing                            │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Title is editable inline
User can start typing immediately
```

## Integration with Day Card Notes Section

### Relationship
```
DAY CARD NOTES SECTION (Prompt 06):
- Shows notes linked to that specific day
- Context: "Notes from this day"
- Can be past, present, or future days

TODAY'S NOTES (This Section):
- Shows notes created TODAY only
- Context: "What you made today"
- Always current day
- Updates in real-time

OVERLAP:
- Notes created today appear in BOTH
- Day card shows notes for viewed day
- Sidebar shows notes for actual today
```

### Syncing Between Sections
```
User views December 9 (today):

┌─────────────────────────────────────┬─────────────────────────────┐
│  DAY CARD (Dec 9)                   │  SIDEBAR                    │
│                                     │                             │
│  📝 Notes                     (3)   │  📝 Today's Notes     (3)   │
│  ────────────────────────────       │  ─────────────────────────  │
│                                     │                             │
│  [Same 3 notes]                     │  [Same 3 notes]             │
│                                     │                             │
└─────────────────────────────────────┴─────────────────────────────┘

User views December 8 (yesterday):

┌─────────────────────────────────────┬─────────────────────────────┐
│  DAY CARD (Dec 8)                   │  SIDEBAR                    │
│                                     │                             │
│  📝 Notes                     (2)   │  📝 Today's Notes     (3)   │
│  ────────────────────────────       │  ─────────────────────────  │
│                                     │                             │
│  [Dec 8's notes]                    │  [Today's notes - Dec 9]    │
│                                     │                             │
└─────────────────────────────────────┴─────────────────────────────┘

Sidebar always shows actual today's notes
Day card shows notes for the viewed day
```

## Data Structure
```typescript
interface TodaysNote {
  id: string;
  title: string;
  createdAt: string;        // ISO timestamp
  folderPath?: string;      // Optional: "Work/Meetings"
  preview?: string;         // Optional: First line
}

interface TodaysNotesState {
  notes: TodaysNote[];
  isLoading: boolean;
  isExpanded: boolean;      // Show all vs show 3
  activeNoteId?: string;    // Currently open in panel
}

// Computed
const todaysNotes = notes.filter(note =>
  isToday(new Date(note.createdAt))
);

// Sorted newest first
const sortedNotes = todaysNotes.sort((a, b) =>
  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
);
```

## Component Structure
```
TodaysNotesSection
├── SectionHeader
│   ├── Icon (📝)
│   ├── Title ("Today's Notes")
│   ├── CreateButton (+) [optional]
│   └── CountBadge
│
├── Separator
│
├── NotesList (if notes.length > 0)
│   ├── NoteItem (×n, max 3-4 initially)
│   │   ├── Time
│   │   ├── Icon
│   │   ├── Title
│   │   └── Arrow
│   │
│   └── ExpandButton (if more than 3-4)
│       └── "+ X more notes"
│
└── EmptyState (if notes.length === 0)
    ├── Icon
    ├── Message
    └── CreateButton
```

## Spacing Specifications
```
Section Container:
├── Padding: 16px
├── Background: Subtle card background
├── Border-radius: 12px
├── Margin-top: 16px (gap from AI Connections)
│
├── Header
│   ├── Margin-bottom: 12px
│   ├── Icon size: 18px
│   ├── Title font: 14px, 500 weight
│   ├── Create button: 24px × 24px
│   └── Count badge: 13px, secondary
│
├── Separator
│   ├── Height: 1px
│   └── Margin-bottom: 12px
│
├── Note Items
│   ├── Padding: 10px 12px
│   ├── Margin-bottom: 8px
│   ├── Border-radius: 8px
│   │
│   ├── Time font: 11px, secondary color
│   ├── Gap (time to title): 4px
│   ├── Icon size: 14px
│   ├── Title font: 13px, primary color
│   ├── Arrow: 14px, secondary
│   └── Truncate title at ~25 chars
│
├── Expand Button
│   ├── Padding: 8px 12px
│   ├── Font: 12px
│   └── Color: Accent/link color
│
└── Empty State
    ├── Padding: 24px
    ├── Icon size: 32px, muted
    ├── Message font: 13px, secondary
    └── Create button: Standard button sizing
```

## Accessibility
```
Section:
- role="region"
- aria-label="Today's Notes"

Note items:
- role="button"
- aria-label="Open Meeting Notes - Design Review, created at 2:34 PM"
- tabindex="0"
- Keyboard: Enter/Space to open

Create button:
- aria-label="Create new note"

Count badge:
- aria-label="5 notes created today"

Empty state:
- Informative message for screen readers

List updates:
- aria-live="polite" on container
- Announce: "New note added" / "Note removed"
```

## Keyboard Navigation
```
Tab         → Focus first note item
Arrow Down  → Next note item
Arrow Up    → Previous note item
Enter       → Open focused note
Escape      → Close panel if open
+           → Create new note (if header create button focused)
```

## Edge Cases

### Midnight Rollover
```
At midnight, notes from "today" become "yesterday":

11:59 PM:
┌─────────────────────────────────────────────────────┐
│   📝  Today's Notes                           (5)   │
│   [5 notes from Dec 9]                              │
└─────────────────────────────────────────────────────┘

12:00 AM (Dec 10):
┌─────────────────────────────────────────────────────┐
│   📝  Today's Notes                                 │
│                                                     │
│   No notes created today                            │
│                                                     │
└─────────────────────────────────────────────────────┘

Behavior:
- List clears at midnight
- Old notes still exist, just not "today"
- Fresh start each day
- No need to handle this in real-time (refresh on next interaction)
```

### Very Long Note Title
```
Title: "Meeting Notes - Q4 2024 Planning Session with Marketing Team"

Truncation:
┌───────────────────────────────────────────────────────┐
│  2:34 PM                                              │
│  📄  Meeting Notes - Q4 2024 Planni...           →   │
└───────────────────────────────────────────────────────┘

Rules:
- Truncate with ellipsis
- Max ~30 characters visible
- Full title in tooltip on hover
- Full title shown when opened
```

### Many Notes (Productive Day)
```
If user creates 15+ notes in one day:

┌─────────────────────────────────────────────────────┐
│   📝  Today's Notes                          (15)   │
│   ─────────────────────────────────────────────────│
│                                                     │
│   [Note 1]                                          │
│   [Note 2]                                          │
│   [Note 3]                                          │
│                                                     │
│   + 12 more notes                                   │
│                                                     │
└─────────────────────────────────────────────────────┘

Expanded view becomes scrollable if needed
Consider: Link to "View all today's notes" page
```

## CSS Implementation
```css
/* Today's Notes Section */
.todays-notes-section {
  padding: 16px;
  background: var(--card-bg);
  border-radius: 12px;
  margin-top: 16px;
}

.todays-notes-header {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}

.todays-notes-header-icon {
  font-size: 18px;
  margin-right: 8px;
}

.todays-notes-header-title {
  font-size: 14px;
  font-weight: 500;
  flex: 1;
}

.todays-notes-header-create {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color 150ms ease;
}

.todays-notes-header-create:hover {
  background-color: var(--hover-bg);
}

.todays-notes-header-count {
  font-size: 13px;
  color: var(--text-secondary);
  margin-left: 8px;
}

/* Note Item */
.todays-note-item {
  padding: 10px 12px;
  margin-bottom: 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 150ms ease;
}

.todays-note-item:hover {
  background-color: var(--hover-bg);
}

.todays-note-item.active {
  background-color: var(--accent-bg-muted);
}

.todays-note-time {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.todays-note-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.todays-note-icon {
  font-size: 14px;
}

.todays-note-title {
  font-size: 13px;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.todays-note-arrow {
  font-size: 14px;
  color: var(--text-secondary);
  transition: color 150ms ease;
}

.todays-note-item:hover .todays-note-arrow {
  color: var(--text-primary);
}

/* Empty State */
.todays-notes-empty {
  padding: 24px;
  text-align: center;
}

.todays-notes-empty-icon {
  font-size: 32px;
  opacity: 0.5;
  margin-bottom: 12px;
}

.todays-notes-empty-message {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 16px;
}

/* Expand Button */
.todays-notes-expand {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--accent-color);
  cursor: pointer;
  border: 1px dashed var(--border-color);
  border-radius: 8px;
  text-align: center;
  transition: background-color 150ms ease;
}

.todays-notes-expand:hover {
  background-color: var(--hover-bg);
}
```

## Expected Output

After implementing this prompt:
1. Section displays in sidebar below AI Connections
2. Shows empty state when no notes today
3. Lists notes with time and title
4. Notes ordered newest first
5. Click opens note in split panel
6. Active note shows highlighted state
7. Real-time updates when notes created/deleted
8. Overflow handled with expand/collapse
9. Create button in header (optional)
10. Proper hover and focus states
11. Titles truncate with ellipsis
12. Accessible with keyboard and screen reader
13. Count badge shows number of notes

## Do Not Include Yet

- Note creation modal/dialog details
- Folder organization within section
- Drag-and-drop reordering
- Note templates

Focus on displaying and navigating to today's notes.

Implementation Notes
TechniqueWhyReal-time subscriptionUpdate list on note changesDate filteringOnly show today's notesOptimistic UIImmediate feedback on create/deleteTruncationHandle long titles in narrow sidebarAnimationSmooth list transitions
Expected Outcome
After implementing this prompt, you should have:

Working Today's Notes section in sidebar
Empty and populated states
Clickable notes opening in panel
Real-time updates on note changes
Expand/collapse for overflow
Optional create button
Proper accessibility