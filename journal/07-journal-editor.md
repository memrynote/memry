# Memry Journal — Journal Editor (Tiptap)

## Overview

Build the journal editor section within each day card using Tiptap. This is a rich text editor that's always visible, supports wiki-links and tags, and includes a toolbar with formatting options, media insertion, and view mode toggles.

## Editor Placement
```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                                ┃
┃   [Header]                                                     ┃
┃                                                                ┃
┃   [Calendar Events - collapsible]                              ┃
┃                                                                ┃
┃   [Overdue Tasks - collapsible]                                ┃
┃                                                                ┃
┃   [Notes Section - always visible]                             ┃
┃                                                                ┃
┃   ┌────────────────────────────────────────────────────────┐   ┃
┃   │                                                        │   ┃
┃   │   ✏️ Journal                                           │   ┃  ← This section
┃   │   ────────────────────────────────────────────────     │   ┃     Always visible
┃   │                                                        │   ┃
┃   │   [Tiptap Editor Area]                                 │   ┃
┃   │                                                        │   ┃
┃   │   ────────────────────────────────────────────────     │   ┃
┃   │   [Toolbar]                                            │   ┃
┃   │                                                        │   ┃
┃   └────────────────────────────────────────────────────────┘   ┃
┃                                                                ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

## Journal Section Structure
```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   ✏️  Journal                                                  │
│                                                                │
│   ──────────────────────────────────────────────────────────   │
│                                                                │
│   ┌──────────────────────────────────────────────────────────┐ │
│   │                                                          │ │
│   │  Today was productive. Had a great meeting with the      │ │
│   │  team about [[Project Alpha]]. We discussed the new      │ │
│   │  timeline and everyone seems aligned.                    │ │
│   │                                                          │ │
│   │  Key takeaways:                                          │ │
│   │  • Deadline moved to Q2                                  │ │
│   │  • Need to hire 2 more engineers                         │ │
│   │  • Budget approved for new tools                         │ │
│   │                                                          │ │
│   │  Feeling optimistic about the direction.                 │ │
│   │                                                          │ │
│   │  #work #planning #wins                                   │ │
│   │                                                          │ │
│   │                                                          │ │
│   │                                                          │ │
│   │                                                          │ │
│   ├──────────────────────────────────────────────────────────┤ │
│   │                                                          │ │
│   │  B  I  U  S  │  🔗  📷  🎤  📎  │  ⋮  │  ◱              │ │
│   │                                                          │ │
│   └──────────────────────────────────────────────────────────┘ │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Editor Area

### Default State (Empty)
```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Start writing...                                                │
│                                                                  │
│                                                                  │
│                                                                  │
│                                                                  │
│                                                                  │
│                                                                  │
│                                                                  │
│                                                                  │
│                                                                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Properties:
- Placeholder text: "Start writing..." (secondary/muted color)
- Min-height: 200px
- Cursor: text (indicates editable)
- Click anywhere to focus
```

### With Content
```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Today was productive. Had a great meeting with the              │
│  team about [[Project Alpha]]. We discussed the new              │
│  timeline and everyone seems aligned.                            │
│                                                                  │
│  Key takeaways:                                                  │
│  • Deadline moved to Q2                                          │
│  • Need to hire 2 more engineers                                 │
│  • Budget approved for new tools                                 │
│                                                                  │
│  Feeling optimistic about the direction.                         │
│                                                                  │
│  #work #planning #wins                                           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Content features:
- [[wiki-links]] styled distinctly (see Prompt 11)
- #tags styled distinctly (see Prompt 11)
- Rich text formatting preserved
- Auto-grows with content (no fixed height)
```

### Focused State
```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Today was productive. Had a great meeting with the              │
│  team about [[Project Alpha]]. We discussed the new              │
│  timeline and everyone seems aligned.|                           │
│                                     ↑                            │
│                               Blinking cursor                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Focus indicators:
- Blinking cursor at insertion point
- Optional: Subtle border color change on container
- Toolbar becomes more prominent (if was faded)
```

## Toolbar Structure
```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   B   I   U   S   │   🔗   📷   🎤   📎   │   ⋮   │   ◱                      │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

    ├─────────────┤   ├───────────────────┤   ├───┤   ├───┤
     Text Format         Media/Insert       More    View Mode
```

### Toolbar Groups
```
GROUP 1: Text Formatting
┌─────────────────────────────────┐
│   B    I    U    S              │
│  Bold Italic Under Strike       │
└─────────────────────────────────┘

GROUP 2: Media & Insert
┌─────────────────────────────────┐
│   🔗    📷    🎤    📎          │
│  Link  Image Voice Attach       │
└─────────────────────────────────┘

GROUP 3: More Options
┌─────────────────────────────────┐
│   ⋮                             │
│  More (dropdown)                │
└─────────────────────────────────┘

GROUP 4: View Mode
┌─────────────────────────────────┐
│   ◱                             │
│  Simple/Focus Mode              │
└─────────────────────────────────┘
```

### Toolbar Button Details
```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│  ┌───┐ ┌───┐ ┌───┐ ┌───┐   ┌───┐ ┌───┐ ┌───┐ ┌───┐   ┌───┐   ┌───┐       │
│  │ B │ │ I │ │ U │ │ S │ │ │🔗 │ │📷 │ │🎤 │ │📎 │ │ │ ⋮ │ │ │ ◱ │       │
│  └───┘ └───┘ └───┘ └───┘   └───┘ └───┘ └───┘ └───┘   └───┘   └───┘       │
│                                                                            │
│   ↑     ↑     ↑     ↑       ↑     ↑     ↑     ↑       ↑       ↑           │
│ Bold Italic Under Strike  Link Image Voice Attach   More    Simple       │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

Button specs:
- Size: 32px × 32px (touch-friendly)
- Border-radius: 6px
- Gap between buttons: 4px
- Gap between groups: 12px (with subtle separator line)
```

## Text Formatting Buttons

### Bold (B)
```
Normal:          Active (text selected is bold):
┌───┐            ┌───┐
│ B │            │▓B▓│  ← Highlighted/filled background
└───┘            └───┘

Keyboard: Cmd/Ctrl + B
Action: Toggle bold on selected text or at cursor
Icon: "B" in bold weight
```

### Italic (I)
```
Normal:          Active:
┌───┐            ┌───┐
│ I │            │▓I▓│
└───┘            └───┘

Keyboard: Cmd/Ctrl + I
Action: Toggle italic on selected text or at cursor
Icon: "I" in italic style
```

### Underline (U)
```
Normal:          Active:
┌───┐            ┌───┐
│ U │            │▓U▓│
└───┘            └───┘

Keyboard: Cmd/Ctrl + U
Action: Toggle underline on selected text or at cursor
Icon: "U" with underline decoration
```

### Strikethrough (S)
```
Normal:          Active:
┌───┐            ┌───┐
│ S̶ │            │▓S̶▓│
└───┘            └───┘

Keyboard: Cmd/Ctrl + Shift + S (or X)
Action: Toggle strikethrough on selected text or at cursor
Icon: "S" with strikethrough decoration
```

## Media & Insert Buttons

### Link (🔗)
```
Button:
┌───┐
│🔗 │
└───┘

Click action → Show link popover:

┌─────────────────────────────────────────┐
│                                         │
│  🔗 Add Link                        ✕   │
│  ─────────────────────────────────────  │
│                                         │
│  URL                                    │
│  ┌─────────────────────────────────┐    │
│  │ https://                        │    │
│  └─────────────────────────────────┘    │
│                                         │
│  Text (optional)                        │
│  ┌─────────────────────────────────┐    │
│  │ Link text                       │    │
│  └─────────────────────────────────┘    │
│                                         │
│           [Cancel]  [Insert Link]       │
│                                         │
└─────────────────────────────────────────┘

If text is selected when clicking:
- "Text" field pre-fills with selected text
- URL field is focused

Keyboard: Cmd/Ctrl + K
```

### Image (📷)
```
Button:
┌───┐
│📷 │
└───┘

Click action → Show image options:

Option A: File picker dialog
┌─────────────────────────────────────────┐
│                                         │
│  📷 Insert Image                    ✕   │
│  ─────────────────────────────────────  │
│                                         │
│  ┌─────────────────────────────────────┐│
│  │                                     ││
│  │     📁 Click to upload              ││
│  │        or drag and drop             ││
│  │                                     ││
│  │     PNG, JPG, GIF up to 10MB        ││
│  │                                     ││
│  └─────────────────────────────────────┘│
│                                         │
│  Or paste image URL:                    │
│  ┌─────────────────────────────────────┐│
│  │ https://                            ││
│  └─────────────────────────────────────┘│
│                                         │
│                          [Insert]       │
│                                         │
└─────────────────────────────────────────┘

After insert:
- Image appears inline in editor
- Can resize by dragging corners
- Click image to show alignment options
```

### Voice Recording (🎤)
```
Button:
┌───┐
│🎤 │
└───┘

Click action → Start recording UI:

State 1: Ready to record
┌─────────────────────────────────────────┐
│                                         │
│  🎤 Voice Note                      ✕   │
│  ─────────────────────────────────────  │
│                                         │
│              ┌─────────┐                │
│              │         │                │
│              │   🎤    │                │
│              │         │                │
│              └─────────┘                │
│          Click to start recording       │
│                                         │
└─────────────────────────────────────────┘

State 2: Recording in progress
┌─────────────────────────────────────────┐
│                                         │
│  🎤 Recording...                    ✕   │
│  ─────────────────────────────────────  │
│                                         │
│              ┌─────────┐                │
│              │  🔴     │  ← Pulsing red │
│              │ 0:24    │  ← Duration    │
│              │         │                │
│              └─────────┘                │
│                                         │
│      [■ Stop]            [Cancel]       │
│                                         │
└─────────────────────────────────────────┘

State 3: Recording complete
┌─────────────────────────────────────────┐
│                                         │
│  🎤 Voice Note                      ✕   │
│  ─────────────────────────────────────  │
│                                         │
│  ┌─────────────────────────────────────┐│
│  │  ▶  ━━━━━━━━●━━━━━━━━━━  0:24      ││ ← Playback
│  └─────────────────────────────────────┘│
│                                         │
│      [Re-record]         [Insert]       │
│                                         │
└─────────────────────────────────────────┘

After insert:
- Audio player widget appears inline
- Shows duration, play/pause button
- Can be deleted like any other block
```

### Attachment (📎)
```
Button:
┌───┐
│📎 │
└───┘

Click action → File picker dialog:
- Opens native file picker
- Accepts common file types (PDF, DOC, TXT, etc.)
- Shows upload progress
- Inserts as attachment block

After insert:
┌──────────────────────────────────────────┐
│  📎  quarterly-report.pdf         1.2MB  │
│      Click to download                   │
└──────────────────────────────────────────┘
```

## More Options Menu (⋮)
```
Button:
┌───┐
│ ⋮ │
└───┘

Click action → Dropdown menu:

┌─────────────────────────────────────┐
│                                     │
│  Heading 1                    ⌘⌥1   │
│  Heading 2                    ⌘⌥2   │
│  Heading 3                    ⌘⌥3   │
│                                     │
│  ─────────────────────────────────  │
│                                     │
│  • Bullet List                ⌘⇧8   │
│  1. Numbered List             ⌘⇧7   │
│  ☑ Checklist                  ⌘⇧9   │
│                                     │
│  ─────────────────────────────────  │
│                                     │
│  " Quote                      ⌘⇧B   │
│  ─ Divider                          │
│  </> Code Block               ⌘⇧C   │
│                                     │
│  ─────────────────────────────────  │
│                                     │
│  🧹 Clear Formatting          ⌘\    │
│                                     │
└─────────────────────────────────────┘
```

### Heading Options
```
Heading 1:
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  # Large Heading Text                                            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
Font-size: 24px, Weight: 700

Heading 2:
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  ## Medium Heading Text                                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
Font-size: 20px, Weight: 600

Heading 3:
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  ### Small Heading Text                                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
Font-size: 17px, Weight: 600
```

### List Options
```
Bullet List:
┌──────────────────────────────────────────────────────────────────┐
│  • First item                                                    │
│  • Second item                                                   │
│  • Third item                                                    │
└──────────────────────────────────────────────────────────────────┘

Numbered List:
┌──────────────────────────────────────────────────────────────────┐
│  1. First item                                                   │
│  2. Second item                                                  │
│  3. Third item                                                   │
└──────────────────────────────────────────────────────────────────┘

Checklist:
┌──────────────────────────────────────────────────────────────────┐
│  ☐ Unchecked item                                                │
│  ☑ Checked item (strikethrough optional)                         │
│  ☐ Another item                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Other Blocks
```
Quote:
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  ┃ This is a quote block. It has a left border                   │
│  ┃ and slightly different styling to stand out.                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
Left border: 3px accent color, padding-left: 16px, italic optional

Divider:
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Some text above                                                 │
│                                                                  │
│  ─────────────────────────────────────────────────────────────   │
│                                                                  │
│  Some text below                                                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Code Block:
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ const greeting = "Hello, World!";                          │  │
│  │ console.log(greeting);                                     │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
Monospace font, background: subtle code background
```

## View Mode Button (◱)
```
Button:
┌───┐
│ ◱ │  ← Square with corner indicator
└───┘

States:
- Full Mode (default): Normal icon
- Simple Mode: Icon highlighted/active
- Focus Mode: Different icon or double-highlighted

Click behavior:
Full Mode → Simple Mode → Focus Mode → Full Mode (cycle)

OR two separate buttons:
┌───┐ ┌───┐
│ ◱ │ │ ⛶ │
└───┘ └───┘
Simple Focus
```

See **Prompt 08** (Simple Mode) and **Prompt 09** (Focus Mode) for details.

## Toolbar Button States

### Normal State
```
┌───┐
│ B │
└───┘

Properties:
- Background: Transparent
- Color: Secondary text color
- Border: None
- Cursor: Pointer
```

### Hover State
```
┌───┐
│▒B▒│
└───┘

Properties:
- Background: Subtle hover color
- Color: Primary text color
- Transition: 150ms ease
```

### Active State (Format Applied)
```
┌───┐
│▓B▓│
└───┘

Properties:
- Background: Accent color (muted)
- Color: Accent text color
- Indicates this format is currently applied to selection/cursor
```

### Disabled State
```
┌───┐
│ B │  (faded)
└───┘

Properties:
- Opacity: 0.4
- Cursor: Not-allowed
- Used when action unavailable (e.g., no text selected for link)
```

## Keyboard Shortcuts
```
Text Formatting:
├── Cmd/Ctrl + B      → Bold
├── Cmd/Ctrl + I      → Italic
├── Cmd/Ctrl + U      → Underline
└── Cmd/Ctrl + Shift + S → Strikethrough

Insert:
├── Cmd/Ctrl + K      → Insert link
└── Cmd/Ctrl + Shift + I → Insert image (optional)

Structure:
├── Cmd/Ctrl + Alt + 1  → Heading 1
├── Cmd/Ctrl + Alt + 2  → Heading 2
├── Cmd/Ctrl + Alt + 3  → Heading 3
├── Cmd/Ctrl + Shift + 7 → Numbered list
├── Cmd/Ctrl + Shift + 8 → Bullet list
├── Cmd/Ctrl + Shift + 9 → Checklist
├── Cmd/Ctrl + Shift + B → Quote
└── Cmd/Ctrl + Shift + C → Code block

Editing:
├── Cmd/Ctrl + Z      → Undo
├── Cmd/Ctrl + Shift + Z → Redo
├── Cmd/Ctrl + \      → Clear formatting
└── Cmd/Ctrl + A      → Select all

Special:
├── [[ → Trigger wiki-link autocomplete
├── #  → Trigger tag autocomplete
└── /  → Trigger slash command menu (optional)
```

## Slash Commands (Optional Feature)
```
User types "/" at start of line:

┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  /                                                               │
│  ┌─────────────────────────────────────┐                         │
│  │                                     │                         │
│  │  📝 Text                            │                         │
│  │  # Heading 1                        │                         │
│  │  ## Heading 2                       │                         │
│  │  • Bullet List                      │                         │
│  │  1. Numbered List                   │                         │
│  │  ☑ Checklist                        │                         │
│  │  " Quote                            │                         │
│  │  </> Code                           │                         │
│  │  ─ Divider                          │                         │
│  │  📷 Image                           │                         │
│  │  🎤 Voice Note                      │                         │
│  │                                     │                         │
│  └─────────────────────────────────────┘                         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Behavior:
- Arrow keys to navigate
- Enter to select
- Type to filter: "/head" shows only heading options
- Escape to dismiss
```

## Inline Elements

### Wiki-Link Display
```
Normal text [[Project Alpha]] more text

Rendered:
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Normal text  Project Alpha  more text                           │
│               └────┬────┘                                        │
│                    └── Styled as link (accent color, underline)  │
│                        Click to navigate                         │
│                        Hover shows preview (optional)            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

See Prompt 11 for full wiki-link details.
```

### Tag Display
```
Some text #work #planning #wins

Rendered:
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Some text  #work  #planning  #wins                              │
│             └─┬──┘ └───┬────┘ └─┬──┘                             │
│               └────────┴────────┴── Styled as tags               │
│                   Background pill, accent color                  │
│                   Click to filter by tag                         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

See Prompt 11 for full tag details.
```

## Auto-Save Behavior
```
Save triggers:
├── Every 2 seconds of inactivity after typing
├── On blur (when editor loses focus)
├── Before navigating away
└── On explicit Cmd/Ctrl + S (optional confirmation)

Visual feedback:
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│  ✏️  Journal                                               Saving...       │
│                                                            ↑               │
│                                                            Subtle indicator│
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

After save:
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│  ✏️  Journal                                               ✓ Saved         │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

States:
- "Saving..." during save operation
- "✓ Saved" for 2 seconds after successful save
- Then indicator fades/hides
- "⚠️ Save failed" if error (with retry option)
```

## Editor Sizing

### Minimum Height
```
Empty editor:
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Start writing...                                                │  ← Min-height: 200px
│                                                                  │
│                                                                  │
│                                                                  │
│                                                                  │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  B I U S │ 🔗 📷 🎤 📎 │ ⋮ │ ◱                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Auto-Grow
```
With lots of content:
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Today was productive...                                         │
│                                                                  │
│  [Many paragraphs of content...]                                 │
│                                                                  │
│  [Content continues...]                                          │
│                                                                  │  ← Height grows
│  [More content...]                                               │     with content
│                                                                  │
│  [Even more content...]                                          │
│                                                                  │
│  #work #planning                                                 │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  B I U S │ 🔗 📷 🎤 📎 │ ⋮ │ ◱                                   │
└──────────────────────────────────────────────────────────────────┘

Properties:
- No max-height (grows infinitely)
- Page scrolls to accommodate
- Toolbar stays at bottom of editor (not fixed to viewport)
```

### Maximum Height Option
```
If you want to cap editor height with internal scroll:

┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Today was productive...                                         │
│                                                                  │
│  [Content...]                                                    │
│                                                                  │  ← Max-height: 500px
│  [More content...]                                             ▲ │     Internal scroll
│                                                                █ │
│  [Content cut off...]                                          █ │
│                                                                ▼ │
├──────────────────────────────────────────────────────────────────┤
│  B I U S │ 🔗 📷 🎤 📎 │ ⋮ │ ◱                                   │
└──────────────────────────────────────────────────────────────────┘

Recommendation: Auto-grow (no max) for better writing experience
```

## Component Structure
```
JournalSection
├── SectionHeader
│   ├── Icon (✏️)
│   ├── Title ("Journal")
│   └── SaveIndicator ("Saving..." | "✓ Saved")
│
├── Separator
│
└── EditorContainer
    ├── TiptapEditor
    │   ├── EditorContent (main writing area)
    │   └── BubbleMenu (optional, on text selection)
    │
    └── Toolbar
        ├── FormatGroup
        │   ├── BoldButton
        │   ├── ItalicButton
        │   ├── UnderlineButton
        │   └── StrikethroughButton
        │
        ├── Separator
        │
        ├── MediaGroup
        │   ├── LinkButton
        │   ├── ImageButton
        │   ├── VoiceButton
        │   └── AttachButton
        │
        ├── Separator
        │
        ├── MoreButton (dropdown)
        │
        ├── Separator
        │
        └── ViewModeButton
```

## Data Structure
```typescript
interface JournalEntry {
  id: string;
  date: string;              // "2024-12-09"
  content: string;           // HTML or JSON (Tiptap format)
  characterCount: number;    // For heatmap calculation
  createdAt: string;
  updatedAt: string;
}

interface JournalEditorProps {
  entry: JournalEntry | null;
  onContentChange: (content: string) => void;
  onSave: () => Promise;
  autoSave?: boolean;        // Default: true
  placeholder?: string;      // Default: "Start writing..."
}

// Tiptap extensions needed:
const extensions = [
  StarterKit,                // Basic formatting
  Underline,
  Link,
  Image,
  Placeholder,
  WikiLink,                  // Custom (Prompt 11)
  Tag,                       // Custom (Prompt 11)
  // Audio, Attachment (custom)
];
```

## Tiptap Configuration
```typescript
// Basic Tiptap setup
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3],
      },
    }),
    Underline,
    Link.configure({
      openOnClick: false,      // Handle clicks manually
      HTMLAttributes: {
        class: 'editor-link',
      },
    }),
    Image.configure({
      inline: false,
      allowBase64: true,
    }),
    Placeholder.configure({
      placeholder: 'Start writing...',
    }),
    // Custom extensions for wiki-links, tags
  ],
  content: initialContent,
  onUpdate: ({ editor }) => {
    const html = editor.getHTML();
    onContentChange(html);
  },
  editorProps: {
    attributes: {
      class: 'journal-editor-content',
    },
  },
});
```

## Spacing Specifications
```
Journal Section:
├── Padding: 16px
├── Background: Subtle card background
├── Border-radius: 8px
│
├── Header
│   ├── Margin-bottom: 12px
│   ├── Icon size: 18px
│   ├── Title font: 14px, 500 weight
│   └── Save indicator: 12px, secondary color
│
├── Separator
│   ├── Height: 1px
│   └── Margin-bottom: 12px
│
├── Editor Area
│   ├── Min-height: 200px
│   ├── Padding: 12px
│   ├── Font-size: 15px
│   ├── Line-height: 1.6
│   └── Font-family: System font or custom
│
└── Toolbar
    ├── Padding: 8px 12px
    ├── Border-top: 1px border color
    ├── Background: Slightly different from editor
    ├── Button size: 32px × 32px
    ├── Button gap: 4px
    └── Group separator gap: 12px
```

## Accessibility
```
Editor:
- role="textbox"
- aria-multiline="true"
- aria-label="Journal entry for December 9, 2024"
- aria-placeholder="Start writing..."

Toolbar buttons:
- aria-label="Bold" (etc. for each)
- aria-pressed="true/false" for format toggles
- role="toolbar" on toolbar container
- Keyboard navigable (Tab, Arrow keys)

Format state announcements:
- "Bold applied" when toggling on
- "Bold removed" when toggling off
```

## Expected Output

After implementing this prompt:
1. Tiptap editor renders within journal section
2. Placeholder shows when empty
3. All toolbar formatting buttons work
4. Bold, Italic, Underline, Strikethrough toggles
5. Link insertion with popover
6. Image upload and insertion
7. Voice recording and insertion
8. File attachment
9. More menu with headings, lists, quote, code, divider
10. Auto-save with visual indicator
11. Keyboard shortcuts functional
12. Editor auto-grows with content
13. Proper accessibility attributes

## Do Not Include Yet

- Wiki-link autocomplete (Prompt 11)
- Tag autocomplete (Prompt 11)
- Simple Mode behavior (Prompt 08)
- Focus Mode behavior (Prompt 09)

Focus on core editor functionality and toolbar.

Implementation Notes
TechniqueWhyTiptapModern, extensible, React-friendly editorProseMirror under hoodRobust document modelCustom extensionsWiki-links, tags, audio blocksDebounced auto-savePrevent excessive savesToolbar state syncReflect current selection formatting
Expected Outcome
After implementing this prompt, you should have:

Working Tiptap rich text editor
Full toolbar with formatting options
Media insertion (link, image, voice, attach)
More options dropdown
Auto-save functionality
Keyboard shortcut support
Proper accessibility

