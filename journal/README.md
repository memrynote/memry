# Memry Journal Page — Build Guide

## Overview

This folder contains step-by-step prompts to build the Memry Journal page. Each prompt is a logical chunk that builds upon the previous one.

## Target Users

- **Casual Users**: Want simplicity, just write
- **PKM Nerds**: Want [[wiki-links]], #tags, and connections

## Core Concept

An infinite-scroll journal where:
- **Today is always in focus** (100% opacity, full color)
- **Past days fade above** (scroll up = go to past)
- **Future days fade below** (scroll down = go to future, dotted border)
- **Right sidebar** contains calendar heatmap, AI connections, and today's notes

## Three View Modes

| Mode | Description |
|------|-------------|
| **Full Mode** | All features visible (default) |
| **Simple Mode** | Just the editor, no sidebar, no sections |
| **Focus Mode** | Full screen editor only |

## Page Layout
```
┌─────────────────────────────────────────────┬───────────────────────────────┐
│                                             │                               │
│           INFINITE SCROLL AREA              │        RIGHT SIDEBAR          │
│           (Days stack vertically)           │        (Fixed position)       │
│                                             │                               │
│    ░░░ Past Day (faded) ░░░                │   📅 Calendar Heatmap         │
│                                             │                               │
│    ━━━ ACTIVE DAY (full color) ━━━         │   ⚡ AI Connections            │
│    │ Calendar Events (collapsed)  │         │                               │
│    │ Overdue Tasks (collapsed)    │         │   📝 Today's Notes            │
│    │ Notes Section                │         │                               │
│    │ Journal Editor (Tiptap)      │         │                               │
│    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━          │                               │
│                                             │                               │
│    ┄┄┄ Future Day (faded, dotted) ┄┄┄      │                               │
│                                             │                               │
└─────────────────────────────────────────────┴───────────────────────────────┘
```

## Day Card Sections

1. **Header**: Date, day name, weather (optional)
2. **Calendar Events**: Collapsed by default, shows meeting count
3. **Overdue Tasks**: Collapsed by default, shows task count
4. **Notes**: Always visible, click opens split view
5. **Journal Editor**: Tiptap rich text with toolbar

## Scroll Behavior

- **Up = Past**: Older days fade with lower opacity
- **Down = Future**: Future days have dotted borders
- **Active Day**: Closest to viewport center = 100% opacity
- **Calendar Click**: Smooth scroll animation to selected day

## Heatmap Logic (GitHub-style)

| Characters Written | Color Level |
|--------------------|-------------|
| 0 | No color |
| 1-100 | Level 1 (lightest) |
| 101-500 | Level 2 |
| 501-1000 | Level 3 |
| 1000+ | Level 4 (darkest) |

## Build Order

Follow the prompts in numbered order:
1. Start with page layout
2. Add infinite scroll logic
3. Build day card structure
4. Add calendar heatmap
5. Implement collapsible sections
6. Add notes with split view
7. Integrate Tiptap editor
8. Add Simple Mode
9. Add Focus Mode
10. Add AI Connections
11. Implement wiki-links and tags
12. Complete sidebar notes

## Tech Stack Assumptions

- React/Next.js
- Tiptap for rich text editor
- Tailwind CSS for styling
- Framer Motion for animations (optional)

## Key Interactions

| Action | Result |
|--------|--------|
| Scroll | Days fade in/out based on position |
| Click calendar day | Smooth scroll to that day |
| Click [Today] button | Scroll to current day |
| Click note | Split view panel slides in |
| Click ◱ (Simple Mode) | Hide sidebar and sections |
| Click ◱ (Focus Mode) | Full screen editor |
| Type `[[` | Wiki-link autocomplete |
| Type `#` | Tag autocomplete |
| Complete task | Task fades out and disappears |
| Expand collapsed section | Section animates open |


## Folder
```
.journal/
├── README.md
├── 01-page-layout.md
├── 02-infinite-scroll.md
├── 03-day-card-structure.md
├── 04-calendar-heatmap.md
├── 05-collapsible-sections.md
├── 06-notes-section.md
├── 07-journal-editor.md
├── 08-simple-mode.md
├── 09-focus-mode.md
├── 10-ai-connections.md
├── 11-wiki-links-tags.md
└── 12-sidebar-notes.md
```
