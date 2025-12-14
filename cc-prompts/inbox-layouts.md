# Memry Inbox Page — UI/UX Layout Specifications

---

## Table of Contents
1. [Design Principles](#design-principles)
2. [Content Types](#content-types)
3. [Page Shell & Structure](#page-shell--structure)
4. [Density Views](#density-views)
5. [Visual Differentiation by Type](#visual-differentiation-by-type)
6. [Empty States](#empty-states)
7. [Filing & Organization](#filing--organization)
8. [Search & Filtering](#search--filtering)
9. [Keyboard Shortcuts](#keyboard-shortcuts)
10. [Snooze Feature](#snooze-feature)

---

## Design Principles

### The 6 Core Principles

| # | Principle | Implementation |
|---|-----------|----------------|
| 1 | **Capture instantly, organize later** | One-action capture from any source. Items land in inbox without requiring categorization. |
| 2 | **Visual differentiation by type** | Automatic rich previews: URLs → cards with favicon/image, Images → thumbnails, Voice → waveform + duration, Text → first lines. |
| 3 | **Clear "processed" destination** | Explicit flow: Inbox → Folder/Space. Visual feedback when items are filed. Inbox Zero celebration state. |
| 4 | **Transparent AI assistance** | AI suggests destinations with confidence indicators. Easy one-click override. Never auto-file without consent. |
| 5 | **Progressive disclosure** | New users see simple view. Filtering, bulk ops, keyboard shortcuts reveal as users engage. |
| 6 | **Dual triage modes** | Grid/Card view for visual browsing. List view with shortcuts for rapid processing. |

### Visual Language
- **Icons** → Content type identification (link, note, image, voice, PDF, etc.)
- **Colors** → User-applied categorization tags (not automatic)
- **Density** → User preference for information display

---

## Content Types

### Expanded Type System

| Type | Icon | Visual Treatment | Metadata |
|------|------|------------------|----------|
| `link` | Link | Rich preview card (favicon, title, hero image, excerpt) | Domain, date saved |
| `note` | FileText | First 2-3 lines of text | Word count, date |
| `image` | Image | Thumbnail preview | Dimensions, file size |
| `voice` | Mic | Waveform visualization + duration badge | Duration, transcription status |
| `pdf` | FileText (red) | First page thumbnail + title | Pages, file size |
| `webclip` | Scissors | Highlighted excerpt + source URL | Source domain, highlight count |
| `file` | File | Icon by file type + filename | Extension, file size |
| `video` | Video | Thumbnail with play icon + duration | Duration, source |

---

## Page Shell & Structure

### Master Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  SIDEBAR (240px)  │              MAIN CONTENT                       │
│                   │                                                 │
│  [Logo]           │  ┌─────────────────────────────────────────┐   │
│                   │  │            HEADER BAR                    │   │
│  ─────────────    │  │  Title | Count | Search | Filters | View │   │
│                   │  └─────────────────────────────────────────┘   │
│  • Inbox (12)     │                                                 │
│  • Journal        │  ┌─────────────────────────────────────────┐   │
│  • Tasks          │  │                                         │   │
│  • Notes          │  │          CONTENT AREA                   │   │
│                   │  │     (List / Card / Expanded View)       │   │
│  ─────────────    │  │                                         │   │
│                   │  │     [Scrollable Item Feed]              │   │
│  Folders          │  │                                         │   │
│  > Work           │  │                                         │   │
│  > Personal       │  │                                         │   │
│  > Research       │  └─────────────────────────────────────────┘   │
│                   │                                                 │
│                   │  ┌─────────────────────────────────────────┐   │
│                   │  │  BULK ACTION BAR (when selecting)       │   │
│                   │  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Header Bar Detail

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Inbox                    ┌──────────────────┐                       │
│  ○ 24 items · 5 today     │ 🔍 Search...     │   [Filters]  [View]   │
│                           └──────────────────┘                       │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

Components:
├── Title: "Inbox" (h1, font-semibold, text-2xl)
├── Badge: "24 items · 5 today" (muted, secondary)
├── Search: Expandable input (icon trigger → full width on focus)
├── Filters: Dropdown or toggle pills (hidden by default → progressive)
└── View Toggle: [List] [Card] [Expanded] icon buttons
```

---

## Density Views

### 1. COMPACT VIEW (List)
**Purpose**: Power users processing many items rapidly
**Density**: Maximum items per screen, minimal chrome

```
┌──────────────────────────────────────────────────────────────────────┐
│ □  🔗  How to Build a Second Brain — Forte Labs          2h ago  ⋮  │
├──────────────────────────────────────────────────────────────────────┤
│ □  📝  Meeting notes: Q4 planning session                3h ago  ⋮  │
├──────────────────────────────────────────────────────────────────────┤
│ □  🖼️  whiteboard-sketch.png                             5h ago  ⋮  │
├──────────────────────────────────────────────────────────────────────┤
│ □  🎤  Voice memo — Project ideas (2:34)                 1d ago  ⋮  │
├──────────────────────────────────────────────────────────────────────┤
│ □  📄  Q3-Report.pdf (12 pages)                          1d ago  ⋮  │
└──────────────────────────────────────────────────────────────────────┘

Row Structure (height: 44px):
├── Checkbox: 20px (selection, hidden until hover or bulk mode)
├── Type Icon: 16px (content type indicator)
├── Title: flex-1 (truncated single line)
├── Timestamp: 60px (relative time, muted)
└── Actions: 24px (⋮ menu, appears on hover)
```

#### Compact View — Item States

```
DEFAULT:
│ □  🔗  How to Build a Second Brain — Forte Labs          2h ago  ⋮  │
     │                                                              │
     └─ type icon                                    actions (hover)┘

HOVER:
│ ☑  🔗  How to Build a Second Brain — Forte Labs      [File] [👁] [⋮]│
     │                                                     │
     └─ checkbox visible                    quick actions visible ──┘

SELECTED:
│ ☑  🔗  How to Build a Second Brain — Forte Labs          2h ago  ⋮  │
  │
  └─ bg-accent/50, checkbox filled

FOCUSED (keyboard nav):
│ □  🔗  How to Build a Second Brain — Forte Labs          2h ago  ⋮  │
  │
  └─ ring-2 ring-primary outline
```

---

### 2. MEDIUM VIEW (Default)
**Purpose**: Balanced view for most users
**Density**: Comfortable scanning with preview content

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  □  🔗  How to Build a Second Brain — Forte Labs                     │
│        fortelabs.com · 2 hours ago                                   │
│        "The PARA method helps you organize information..."           │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  □  📝  Meeting notes: Q4 planning session                           │
│        3 hours ago · 847 words                                       │
│        "Discussed roadmap priorities. Key decisions: 1) Launch..."   │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  □  🎤  Voice memo — Project ideas                                   │
│        1 day ago · 2:34 duration                                     │
│        ▁▂▃▅▇▅▃▂▁▂▃▅▆▇▆▅▃▂▁  [▶ Play]                                │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  □  🖼️  whiteboard-sketch.png                                        │
│        5 hours ago · 1920×1080 · 2.4 MB                              │
│        ┌────────────────┐                                            │
│        │   [Thumbnail]  │                                            │
│        │     Preview    │                                            │
│        └────────────────┘                                            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

Row Structure (height: 80-120px depending on type):
├── Checkbox: Left edge (selection)
├── Type Icon: 20px with type-specific color
├── Content Block:
│   ├── Title: font-medium, text-base
│   ├── Meta Line: domain/timestamp/stats (text-sm, muted)
│   └── Preview: Type-specific content preview
└── Actions: Right edge (hover reveal)
```

#### Medium View — Type-Specific Layouts

**LINK:**
```
┌──────────────────────────────────────────────────────────────────────┐
│  □                                                                   │
│     🔗  How to Build a Second Brain — Forte Labs                     │
│         fortelabs.com · 2 hours ago                                  │
│         ┌──────────┐                                                 │
│         │ [Hero    │  "The PARA method helps you organize           │
│         │  Image]  │   information by actionability..."              │
│         └──────────┘                                                 │
│                                                        [File] [👁] ⋮ │
└──────────────────────────────────────────────────────────────────────┘
```

**NOTE:**
```
┌──────────────────────────────────────────────────────────────────────┐
│  □                                                                   │
│     📝  Meeting notes: Q4 planning session                           │
│         3 hours ago · 847 words                                      │
│                                                                      │
│         "Discussed roadmap priorities. Key decisions:                │
│          1) Launch inbox feature by end of month                     │
│          2) Defer AI suggestions to v2..."                           │
│                                                        [File] [👁] ⋮ │
└──────────────────────────────────────────────────────────────────────┘
```

**IMAGE:**
```
┌──────────────────────────────────────────────────────────────────────┐
│  □                                                                   │
│     🖼️  whiteboard-sketch.png                                        │
│         5 hours ago · 1920×1080 · 2.4 MB                             │
│                                                                      │
│         ┌─────────────────────────────────┐                          │
│         │                                 │                          │
│         │        [Image Thumbnail]        │                          │
│         │         ~160px height           │                          │
│         │                                 │                          │
│         └─────────────────────────────────┘                          │
│                                                        [File] [👁] ⋮ │
└──────────────────────────────────────────────────────────────────────┘
```

**VOICE:**
```
┌──────────────────────────────────────────────────────────────────────┐
│  □                                                                   │
│     🎤  Voice memo — Project ideas                                   │
│         1 day ago · 2:34 duration                                    │
│                                                                      │
│         ▁▂▃▅▇▅▃▂▁▂▃▅▆▇▆▅▃▂▁▂▃▅▇▅▃▂▁▂▃▅▆▇▆▅▃▂                         │
│         [▶]  0:00 ─────────○───────────── 2:34                       │
│                                                                      │
│         💬 "I was thinking about the new feature..."                 │
│            (auto-transcribed)                                        │
│                                                        [File] [👁] ⋮ │
└──────────────────────────────────────────────────────────────────────┘
```

**PDF:**
```
┌──────────────────────────────────────────────────────────────────────┐
│  □                                                                   │
│     📄  Q3-Financial-Report.pdf                                      │
│         Yesterday · 12 pages · 3.2 MB                                │
│                                                                      │
│         ┌──────────┐                                                 │
│         │ [Page 1  │  "Quarterly Revenue Summary                     │
│         │  Preview]│   Total Revenue: $2.4M..."                      │
│         └──────────┘                                                 │
│                                                        [File] [👁] ⋮ │
└──────────────────────────────────────────────────────────────────────┘
```

**WEBCLIP:**
```
┌──────────────────────────────────────────────────────────────────────┐
│  □                                                                   │
│     ✂️  Clipped from: The Future of PKM                              │
│         medium.com · 3 hours ago · 2 highlights                      │
│                                                                      │
│         ┃ "The key insight is that personal knowledge               │
│         ┃  management isn't about storage—it's about                │
│         ┃  retrieval and connection."                               │
│                                                                      │
│         + 1 more highlight                                           │
│                                                        [File] [👁] ⋮ │
└──────────────────────────────────────────────────────────────────────┘
```

---

### 3. EXPANDED VIEW (Review)
**Purpose**: Detailed inspection without opening preview panel
**Density**: Full content visibility, one item at a time focus

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                                                                │  │
│  │  🔗  LINK                                          2 hours ago │  │
│  │                                                                │  │
│  │  How to Build a Second Brain — Forte Labs                      │  │
│  │  fortelabs.com                                                 │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │                                                          │  │  │
│  │  │                    [Hero Image]                          │  │  │
│  │  │                    Full Width                            │  │  │
│  │  │                    ~200px height                         │  │  │
│  │  │                                                          │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  │                                                                │  │
│  │  The PARA method helps you organize information by            │  │
│  │  actionability. Instead of organizing by topic, you           │  │
│  │  organize by how actionable each piece of information is...   │  │
│  │                                                                │  │
│  │  ───────────────────────────────────────────────────────────   │  │
│  │                                                                │  │
│  │  AI Suggestion: 85% confident                                  │  │
│  │  📁 Research / PKM Methods                     [Accept] [✗]    │  │
│  │                                                                │  │
│  │  ───────────────────────────────────────────────────────────   │  │
│  │                                                                │  │
│  │  [🏷️ Add Tags]                                                 │  │
│  │                                                                │  │
│  │  ───────────────────────────────────────────────────────────   │  │
│  │                                                                │  │
│  │  [📁 File to Folder]  [🔗 Open Original]  [🕐 Snooze]  [🗑️]    │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ────────────────────── Next Item ──────────────────────             │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  📝  NOTE                                          3 hours ago │  │
│  │  ...                                                           │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

Card Structure:
├── Type Badge: Top-left, pill style (icon + label)
├── Timestamp: Top-right, muted
├── Title: Large, prominent (text-xl, font-semibold)
├── Source: Below title, muted link
├── Hero Content: Full-width media preview
├── Excerpt: Full text excerpt (not truncated)
├── AI Suggestion: Conditional, shows when confident
├── Tag Input: Inline tag pills with add button
└── Action Bar: Full action buttons at bottom
```

---

## Visual Differentiation by Type

### Icon + Color System

```
┌─────────────────────────────────────────────────────────────────┐
│  TYPE        │  ICON          │  ICON COLOR       │  BG TINT    │
├─────────────────────────────────────────────────────────────────┤
│  link        │  Link2         │  blue-500         │  blue-50    │
│  note        │  FileText      │  amber-600        │  amber-50   │
│  image       │  Image         │  emerald-500      │  emerald-50 │
│  voice       │  Mic           │  violet-500       │  violet-50  │
│  pdf         │  FileText      │  red-500          │  red-50     │
│  webclip     │  Scissors      │  cyan-500         │  cyan-50    │
│  file        │  File          │  stone-500        │  stone-50   │
│  video       │  Video         │  pink-500         │  pink-50    │
└─────────────────────────────────────────────────────────────────┘

Note: Background tints are subtle (#50 variants) and only used in
Card/Expanded views. List view uses icon color only.
```

### User-Applied Color Tags (Separate from Type)

```
Tags are user-applied categorization, distinct from type:

┌──────────────────────────────────────────────────────────────────────┐
│  □  🔗  How to Build a Second Brain           [🟢 Work] [🔵 PKM]    │
│        fortelabs.com · 2 hours ago                                   │
└──────────────────────────────────────────────────────────────────────┘

Tag Color Palette (user-selectable):
├── 🔴 Red      (#EF4444)
├── 🟠 Orange   (#F97316)
├── 🟡 Yellow   (#EAB308)
├── 🟢 Green    (#22C55E)
├── 🔵 Blue     (#3B82F6)
├── 🟣 Purple   (#A855F7)
├── ⚫ Gray     (#6B7280)
└── Custom colors via picker
```

---

## Empty States

### State 1: Getting Started (First Time)
**Trigger**: No items ever captured, no filing history

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│                                                                      │
│                         ┌─────────────┐                              │
│                         │             │                              │
│                         │   📥        │                              │
│                         │   Inbox     │                              │
│                         │             │                              │
│                         └─────────────┘                              │
│                                                                      │
│                    Your inbox is ready                               │
│                                                                      │
│            Capture ideas, links, and files from anywhere.            │
│            They'll appear here until you're ready to organize.       │
│                                                                      │
│                                                                      │
│           ╭──────────────────────────────────────────────╮           │
│           │                                              │           │
│           │  📋  Paste anything          ⌘V              │           │
│           │                                              │           │
│           │  🖱️  Drag & drop files       or click        │           │
│           │                                              │           │
│           │  🌐  Save from browser       Extension       │           │
│           │                                              │           │
│           │  🎤  Record a thought        ⌘⇧R             │           │
│           │                                              │           │
│           ╰──────────────────────────────────────────────╯           │
│                                                                      │
│                                                                      │
│                    [ Try Pasting Something ]                         │
│                         Primary CTA                                  │
│                                                                      │
│                                                                      │
│      ┌──────────────────────────────────────────────────────────┐    │
│      │  Preview: What items will look like                      │    │
│      │                                                          │    │
│      │   🔗  Article title here...                              │    │
│      │   📝  Note preview text...                               │    │
│      │   🖼️  [image thumbnail]                                  │    │
│      │       (ghost/placeholder style)                          │    │
│      └──────────────────────────────────────────────────────────┘    │
│                                                                      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### State 2: Inbox Zero (All Processed)
**Trigger**: Items exist in filing history, inbox currently empty

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│                                                                      │
│                                                                      │
│                           ✨                                         │
│                                                                      │
│                      Inbox Zero!                                     │
│                                                                      │
│               You've processed all 12 items today.                   │
│                                                                      │
│                                                                      │
│                  ┌────────────────────────────┐                      │
│                  │  📊  Today's Stats          │                      │
│                  │                            │                      │
│                  │  📁 8 items filed          │                      │
│                  │  🗑️ 2 items deleted        │                      │
│                  │  🕐 2 items snoozed        │                      │
│                  │                            │                      │
│                  │  ⏱️ Avg processing: 12s    │                      │
│                  └────────────────────────────┘                      │
│                                                                      │
│                                                                      │
│              New items will appear here automatically.               │
│                                                                      │
│                   [ Capture Something New ]                          │
│                                                                      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### State 3: Returning Empty
**Trigger**: Has filing history, inbox empty, returning after time away

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│                                                                      │
│                         📭                                           │
│                                                                      │
│                   Nothing new in inbox                               │
│                                                                      │
│                                                                      │
│         ┌─────────────────────────────────────────────────┐          │
│         │  Snoozed items returning soon:                  │          │
│         │                                                 │          │
│         │  🔗  Design article — returns tomorrow          │          │
│         │  📝  Meeting notes — returns in 3 days          │          │
│         │                                                 │          │
│         │                    [View Snoozed]               │          │
│         └─────────────────────────────────────────────────┘          │
│                                                                      │
│                                                                      │
│                    [ + Add New Item ]                                │
│                                                                      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Filing & Organization

### Filing Panel (Slide-over)

```
┌──────────────────────────────────────────────────────────────────────┐
│                                              │                       │
│                                              │  ╔═══════════════════╗│
│                                              │  ║    FILE ITEM      ║│
│                                              │  ║                   ║│
│            [Main Content Area]               │  ║  ─────────────    ║│
│                                              │  ║                   ║│
│                                              │  ║  🔗 How to Build  ║│
│                                              │  ║     a Second...   ║│
│                                              │  ║                   ║│
│                                              │  ║  ─────────────    ║│
│                                              │  ║                   ║│
│                                              │  ║  📁 Choose Folder ║│
│                                              │  ║                   ║│
│                                              │  ║  ┌─────────────┐  ║│
│                                              │  ║  │ 🔍 Search   │  ║│
│                                              │  ║  └─────────────┘  ║│
│                                              │  ║                   ║│
│                                              │  ║  SUGGESTED        ║│
│                                              │  ║  ├─ 📁 Research   ║│
│                                              │  ║  └─ 📁 PKM        ║│
│                                              │  ║                   ║│
│                                              │  ║  RECENT           ║│
│                                              │  ║  ├─ 📁 Work       ║│
│                                              │  ║  ├─ 📁 Personal   ║│
│                                              │  ║  └─ 📁 Archive    ║│
│                                              │  ║                   ║│
│                                              │  ║  ALL FOLDERS      ║│
│                                              │  ║  ▶ Work           ║│
│                                              │  ║    ├─ Projects    ║│
│                                              │  ║    └─ References  ║│
│                                              │  ║  ▶ Personal       ║│
│                                              │  ║                   ║│
│                                              │  ║  ─────────────    ║│
│                                              │  ║                   ║│
│                                              │  ║  🏷️ Tags          ║│
│                                              │  ║  [+ Add tag]      ║│
│                                              │  ║                   ║│
│                                              │  ║  ─────────────    ║│
│                                              │  ║                   ║│
│                                              │  ║  [Cancel] [File]  ║│
│                                              │  ║                   ║│
│                                              │  ╚═══════════════════╝│
└──────────────────────────────────────────────────────────────────────┘

Panel Width: 320px
Sections:
├── Item Preview: Compact card showing item being filed
├── AI Suggestion: (if confident) "Suggested: Research/PKM" [Accept]
├── Folder Search: Quick filter for folders
├── Suggested Folders: AI-powered, based on content
├── Recent Folders: User's recently used folders
├── All Folders: Expandable tree view
├── Tags: Pill input with autocomplete
└── Actions: Cancel / File buttons
```

### AI Suggestion Confidence Display

```
HIGH CONFIDENCE (>80%):
┌──────────────────────────────────────────────────────────────────────┐
│  ✨ AI Suggestion                                           85%     │
│                                                                      │
│  📁 Research / PKM Methods                                           │
│                                                                      │
│  Similar items filed here:                                           │
│  • Building a Zettelkasten                                          │
│  • The BASB Method Explained                                         │
│                                                                      │
│                                    [Accept]  [Choose Different]      │
└──────────────────────────────────────────────────────────────────────┘

MEDIUM CONFIDENCE (50-80%):
┌──────────────────────────────────────────────────────────────────────┐
│  💡 AI Suggestion                                           62%     │
│                                                                      │
│  Could be:                                                           │
│  • 📁 Research / PKM Methods                                         │
│  • 📁 Work / References                                              │
│                                                                      │
│                                               [Choose a Folder]      │
└──────────────────────────────────────────────────────────────────────┘

LOW/NO CONFIDENCE:
(No suggestion shown — user selects folder manually)
```

### Drag & Drop Filing

```
Drag item toward sidebar folder:

┌─────────────────────────────────────────────────────────────────────┐
│  SIDEBAR         │              MAIN CONTENT                        │
│                  │                                                  │
│  ─────────────   │   ┌─────────────────────────────────────────┐    │
│                  │   │  🔗  How to Build...  ← DRAGGING        │    │
│  • Inbox (12)    │   └─────────────────────────────────────────┘    │
│  • Journal       │                     ↓                            │
│                  │                                                  │
│  ─────────────   │                                                  │
│                  │                                                  │
│  📁 Research ◄───┼── Drop target highlighted                       │
│    [Drop here]   │                                                  │
│                  │                                                  │
│  📁 Work         │                                                  │
│  📁 Personal     │                                                  │
│                  │                                                  │
└─────────────────────────────────────────────────────────────────────┘

Visual Feedback:
├── Dragging item: Slight opacity reduction, shows "ghost" preview
├── Valid drop target: bg-accent, border-primary, scale(1.02)
├── Invalid area: cursor-not-allowed
└── On drop: Toast "Filed to Research" with [Undo]
```

---

## Search & Filtering

### Search Bar (Expanded State)

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ 🔍  Search inbox...                                         ✕  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Recent searches:                                                    │
│  • "project alpha"                                                   │
│  • "meeting notes"                                                   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

With Results:
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ 🔍  project alpha                                           ✕  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  3 results for "project alpha"                              [Clear]  │
│                                                                      │
│  ────────────────────────────────────────────────────────────────    │
│                                                                      │
│  □  📝  [Project Alpha] kickoff meeting notes                        │
│        Matched: title                                                │
│                                                                      │
│  □  🔗  Project Alpha — Design Spec                                  │
│        Matched: title                                                │
│                                                                      │
│  □  🎤  Voice memo about [project alpha] timeline                    │
│        Matched: transcription                                        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Filter Pills (Progressive Disclosure)

```
DEFAULT (hidden filters):
┌──────────────────────────────────────────────────────────────────────┐
│  Inbox  ○ 24 items            🔍 Search      [≡ Filters]   [View]    │
└──────────────────────────────────────────────────────────────────────┘

FILTERS EXPANDED:
┌──────────────────────────────────────────────────────────────────────┐
│  Inbox  ○ 24 items            🔍 Search      [≡ Filters ▼]  [View]   │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                                                                │  │
│  │  TYPE                                                          │  │
│  │  [All] [🔗 Links] [📝 Notes] [🖼️ Images] [🎤 Voice] [📄 Files]  │  │
│  │                                                                │  │
│  │  TIME                                                          │  │
│  │  [All] [Today] [This Week] [Older] [Stale 7d+]                 │  │
│  │                                                                │  │
│  │  SORT                                                          │  │
│  │  [Newest ▼]  ○ Newest  ○ Oldest  ○ Type                        │  │
│  │                                                                │  │
│  │                                            [Reset] [Apply]     │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘

ACTIVE FILTERS (badge indicator):
┌──────────────────────────────────────────────────────────────────────┐
│  Inbox  ○ 8 items             🔍 Search      [≡ Filters •2]  [View]  │
│                                                                      │
│  Active: [🔗 Links ✕] [This Week ✕]                    [Clear All]   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Keyboard Shortcuts

### Quick Reference (Modal)

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│                      ⌨️  Keyboard Shortcuts                          │
│                                                                      │
│  ─────────────────────────────────────────────────────────────────   │
│                                                                      │
│  NAVIGATION                                                          │
│  ↑ / ↓ or j / k        Move between items                           │
│  Enter or Space        Open preview panel                            │
│  Escape                Close panel / Deselect all                    │
│                                                                      │
│  SELECTION                                                           │
│  x                     Toggle selection                              │
│  ⌘ A                   Select all                                    │
│  ⌘ ⇧ A                 Deselect all                                  │
│                                                                      │
│  ACTIONS                                                             │
│  f                     File selected item(s)                         │
│  t                     Add tags                                      │
│  Delete / Backspace    Delete selected item(s)                       │
│  o                     Open original (links)                         │
│  s                     Snooze selected item(s)                       │
│                                                                      │
│  VIEW                                                                │
│  v                     Toggle view mode (List/Card/Expanded)         │
│  r                     Refresh inbox                                 │
│  /                     Focus search                                  │
│  ?                     Show this help                                │
│                                                                      │
│  ─────────────────────────────────────────────────────────────────   │
│                                                                      │
│                              [Close]                                 │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Inline Hints (List View)

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  □  🔗  How to Build a Second Brain            [f] File  [Enter] ▶   │
│        fortelabs.com · 2 hours ago                                   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

Hint badges appear on hover, showing primary shortcuts.
```

---

## Snooze Feature

### Snooze Menu

```
On item hover or selection:

┌──────────────────────────────────────────────────────────────────────┐
│  □  🔗  How to Build a Second Brain           [File] [🕐] [👁] [⋮]  │
│        fortelabs.com · 2 hours ago                    │              │
│                                                       ▼              │
│                                    ┌─────────────────────────────┐   │
│                                    │  🕐  Snooze until...        │   │
│                                    │                             │   │
│                                    │  ○ Later today    (6 PM)    │   │
│                                    │  ○ Tomorrow       (9 AM)    │   │
│                                    │  ○ This weekend   (Sat 10AM)│   │
│                                    │  ○ Next week      (Mon 9AM) │   │
│                                    │  ○ Pick date...             │   │
│                                    │                             │   │
│                                    └─────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### Snoozed Items Indicator

```
Header when items are snoozed:
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Inbox  ○ 24 items · 3 snoozed                                       │
│                          │                                           │
│                          └─ clickable, shows snoozed items list     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

Snoozed items popover:
┌─────────────────────────────────────┐
│  🕐  Snoozed Items                  │
│                                     │
│  Returning today (2)                │
│  ├─ 🔗 Design article      6 PM     │
│  └─ 📝 Meeting notes       8 PM     │
│                                     │
│  Returning tomorrow (1)             │
│  └─ 🖼️ Whiteboard photo    9 AM     │
│                                     │
│              [View All Snoozed]     │
└─────────────────────────────────────┘
```

### Snooze Return Animation

```
When snoozed item returns, slide in from top with highlight:

┌──────────────────────────────────────────────────────────────────────┐
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  🔔  Snoozed item returned                              [✕]   │  │
│  │                                                                │  │
│  │  □  🔗  Design article                                        │  │
│  │        Snoozed 2 days ago                                      │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ─────────────────────────────────────────────────────────────────   │
│                                                                      │
│  [Regular inbox items below...]                                      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

The returned item:
├── Appears at top of inbox with subtle highlight
├── Shows "Snoozed X ago" instead of capture time
├── Highlight fades after 5 seconds
└── Optional: Desktop notification for returned items
```

---

## Bulk Action Bar

### Floating Bar (When Items Selected)

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│                                                                      │
│  [Inbox content above...]                                            │
│                                                                      │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                                                                │  │
│  │   ☑ 5 selected              [📁 File] [🏷️ Tag] [🕐] [🗑️ Delete]│  │
│  │                                                                │  │
│  │   💡 3 similar items — "PKM articles"            [+ Add to ▼]  │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

Bar Features:
├── Selection count with deselect option
├── Primary actions: File, Tag, Snooze, Delete
├── AI clustering suggestion (when detected)
│   └── "3 similar items — 'PKM articles' [+ Add to selection]"
└── Keyboard hints: f=file, t=tag, s=snooze, Del=delete
```

### AI Cluster Suggestion

```
When selection includes items AI detects as related:

┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   ☑ 2 selected                                                       │
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐    │
│   │  ✨ AI detected 3 more similar items                        │    │
│   │                                                             │    │
│   │  "Articles about Personal Knowledge Management"             │    │
│   │                                                             │    │
│   │  • How to Build a Second Brain                              │    │
│   │  • The Zettelkasten Method                                  │    │
│   │  • Linking Your Thinking                                    │    │
│   │                                                             │    │
│   │                      [Add All to Selection]  [Dismiss]      │    │
│   └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│   [📁 File All] [🏷️ Tag All] [🗑️ Delete All]                        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Stale Items Section

### 7+ Days Old Items

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  [Regular inbox items...]                                            │
│                                                                      │
│  ─────────────────────────────────────────────────────────────────   │
│                                                                      │
│  ⚠️  Items older than 7 days (4)                                     │
│                                                                      │
│  These items have been sitting in your inbox. Consider filing        │
│  or deleting them.                                                   │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  □  🔗  Old article from last month                  12d ago   │  │
│  │  □  📝  Random note                                   8d ago   │  │
│  │  □  🖼️  Screenshot                                    9d ago   │  │
│  │  □  🎤  Voice memo                                   14d ago   │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│              [📁 File All to Unsorted]  [Review One by One]          │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

Design:
├── Collapsible section (expanded by default when items exist)
├── Warning yellow/amber styling
├── Batch actions: "File All to Unsorted" for quick cleanup
└── "Review One by One" enters sequential review mode
```

---

## Responsive Considerations

### Sidebar Collapse (Narrow Windows)

```
FULL WIDTH (>1200px):
┌─────────────────────────────────────────────────────────────────────┐
│  SIDEBAR (240px)  │              MAIN CONTENT                       │
│  Full navigation  │              Full width                         │
└─────────────────────────────────────────────────────────────────────┘

MEDIUM WIDTH (900-1200px):
┌─────────────────────────────────────────────────────────────────────┐
│ SIDEBAR (64px) │                 MAIN CONTENT                       │
│ Icons only     │                 Expanded width                     │
└─────────────────────────────────────────────────────────────────────┘

NARROW WIDTH (<900px):
┌─────────────────────────────────────────────────────────────────────┐
│                         MAIN CONTENT                                │
│  [☰] Hamburger for sidebar                                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Notes

### Files to Create/Modify
- `src/renderer/src/types/index.ts` — Add new content types
- `src/renderer/src/components/inbox/` — Component directory
- `src/renderer/src/components/inbox/compact-view.tsx`
- `src/renderer/src/components/inbox/medium-view.tsx`
- `src/renderer/src/components/inbox/expanded-view.tsx`
- `src/renderer/src/components/inbox/snooze-menu.tsx`
- `src/renderer/src/components/inbox/filter-bar.tsx`
- `src/renderer/src/components/inbox/search-input.tsx`
- `src/renderer/src/lib/snooze-utils.ts`

### Design Tokens (Tailwind)
```
--inbox-item-compact-height: 44px
--inbox-item-medium-height: 80-120px (type-dependent)
--inbox-card-expanded-gap: 24px
--inbox-transition-duration: 200ms
--inbox-stale-days: 7
```
