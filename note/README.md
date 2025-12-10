# Memry Note Editor — Design & Build Specification

## Overview

A clean, distraction-free note editor for the Memry PKM (Personal Knowledge Management)
application. Inspired by Capacities, with a focus on simplicity, property inheritance
from folders, and a tabbed right panel for metadata/connections.

---

## Core Design Philosophy

1. **Clean as Paper** — Main editor is sacred, minimal chrome
2. **Progressive Disclosure** — Advanced features hidden until needed (hover to reveal)
3. **Folder = Type** — Each folder has a property template that notes inherit
4. **Notes vs Files** — Notes get full features; files (PDF, images, audio) get preview only
5. **Right Panel for Everything** — All metadata, links, AI in tabbed right panel

---

## Layout Structure
```
┌──────────────────────────────────────────────────────────────────────────┐
│  HEADER BAR                                                              │
│  [Note Type ▼]  📁 Folder Path                        ⚡Synced    ⋮     │
├──────────────────────────────────────────────────────────────────────────┤
│                                         │                                │
│  TITLE SECTION (with hover utilities)   │   RIGHT PANEL                  │
│  ──────────────────────────────────     │   [Outline] [Links] [Props] [AI]│
│  Emoji + Title                          │   ─────────────────────────────│
│  Description...                         │                                │
│                                         │   Tab content here             │
│  TAGS ROW                               │                                │
│  [Tag1] [Tag2]              🏷 Tags     │                                │
│                                         │                                │
│  PROPERTIES COMPACT ROW                 │                                │
│  Value · Value · Value      📋 Props    │                                │
│                                         │                                │
│  ─────────────────────────────────      │                                │
│                                         │                                │
│  MAIN EDITOR                            │                                │
│  (clean, centered, A4-style)            │                                │
│                                         │                                │
│                                         │                                │
├─────────────────────────────────────────┴────────────────────────────────┤
│  FOOTER: Word count • Reading time                    [Panel] [🎯 Focus] │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Component Specifications

### 1. Header Bar
- Note Type dropdown (inherits folder properties)
- Folder breadcrumb path
- Sync status indicator
- More menu (⋮)

### 2. Title Section
- Emoji picker + Title (editable inline)
- Optional description line
- **Hover utilities** (appears on hover, small gray text):
  - ✨ Fill properties
  - 🖼 Add cover
  - ↔ Wide layout

### 3. Tags Row
- Colored tag chips (soft pastel colors from 8×3 palette)
- Click tag label (🏷 Tags) to add/manage
- Empty state: just shows "🏷 Tags"

### 4. Properties Compact Row
- Shows only properties user marked as visible (👁 toggle)
- Values only, no labels (clean)
- Click 📋 Props to open right panel
- Empty state: just shows "📋 Properties"

### 5. Main Editor
- Clean, centered content (max-width ~700px)
- A4/paper-like feel
- Block-based editing
- Minimal formatting toolbar (appears on selection)

### 6. Right Panel (Tabbed)
- **Outline Tab**: Document heading structure, click to navigate
- **Links Tab**: Outgoing links + Backlinks with context
- **Props Tab**: Full property editor with 👁 visibility toggle
- **AI Tab**: Suggestions, related notes, quick actions

### 7. Footer
- Word count, reading time
- Panel toggle button
- Focus mode button

---

## Property System

### Folder → Note Inheritance
- Each folder has a property template
- New notes in folder auto-get these properties (empty values)
- Users can add custom properties per-note

### Property Types
- Text, Long Text, Number, Date
- Checkbox, Select, Multi-Select
- Rating (stars), URL, Relation (link to note), Person

### Compact Bar Visibility
- Each property has 👁 toggle in Props tab
- Only properties with 👁 ON appear in compact row

---

## File Preview (Non-Notes)

Files (PDF, images, audio, video) get simplified view:
- Filename as title (not editable)
- Tags (optional)
- Preview/Player
- Basic file info (size, dimensions, duration)
- NO properties, NO right panel, NO editor

---

## Tag Color Palette

8×3 soft pastel matrix:
- Row 1: Rose, Pink, Fuchsia, Purple, Violet, Indigo, Blue, Sky
- Row 2: Cyan, Teal, Emerald, Green, Lime, Yellow, Amber, Orange
- Row 3: Stone, Slate, Gray, Zinc, Neutral, Warm, Red, Coral

---

## States & Interactions

### Hover Behaviors
- Title section hover → Show utility links (fade in 150ms)
- Block hover → Show drag handle + menu
- Property row hover → Show 👁 toggle

### Empty States
- Tags empty → Just "🏷 Tags" label
- Properties empty → Just "📋 Properties" label
- Clean, no placeholder clutter

### Focus Mode
- Hides all chrome
- Centered content only
- Minimal header/footer on hover

---

## Technical Notes

- React-based component architecture
- Tailwind CSS for styling
- Soft, warm color palette (stone/warm grays)
- Smooth transitions (150ms ease-out)
- Responsive: panel collapses on smaller screens