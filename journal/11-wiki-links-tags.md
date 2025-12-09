markdown# Memry Journal — Wiki-Links and Tags

## Overview

Build the wiki-link (`[[Page Name]]`) and tag (`#tag`) functionality for the Tiptap editor. These are core PKM features that enable bi-directional linking and content organization. Both features include autocomplete suggestions and distinct visual styling.

## Feature Summary
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  WIKI-LINKS                           TAGS                                  │
│                                                                             │
│  Syntax: [[Page Name]]                Syntax: #tagname                      │
│                                                                             │
│  Creates links between pages          Categorizes content                   │
│  Bi-directional connections           Filterable across entries             │
│  Autocomplete from existing           Autocomplete from existing            │
│  Can create new pages                 Creates tag on use                    │
│                                                                             │
│  Example:                             Example:                              │
│  "Working on [[Project Alpha]]"       "Great progress today #work #wins"    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Wiki-Links

### Syntax
```
INPUT (what user types):
[[Project Alpha]]

RENDERED (what user sees):
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Working on  Project Alpha  today with the team.                 │
│              └─────┬─────┘                                       │
│                    └── Styled as internal link                   │
│                        Clickable                                 │
│                        No brackets visible                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

IN EDITOR (while editing):
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Working on [[Project Alpha]] today with the team.               │
│             └───────┬───────┘                                    │
│                     └── Brackets visible during edit             │
│                         Still styled distinctly                  │
│                         Whole unit is selectable                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Visual Styling
```
OPTION A: Inline link style (recommended)
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Working on  Project Alpha  today.                               │
│              └─────┬─────┘                                       │
│                    ├── Color: Accent/link color                  │
│                    ├── Underline: Subtle or on hover             │
│                    ├── Background: None or very subtle           │
│                    └── Cursor: Pointer on hover                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘


OPTION B: Pill/badge style
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Working on ┌──────────────┐ today.                              │
│             │Project Alpha │                                     │
│             └──────────────┘                                     │
│                    ├── Background: Light accent                  │
│                    ├── Border-radius: 4px                        │
│                    ├── Padding: 2px 6px                          │
│                    └── Distinct from regular text                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘


OPTION C: Icon prefix
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Working on 📄 Project Alpha today.                              │
│             ↑  └─────┬─────┘                                     │
│             │        └── Link text in accent color               │
│             └── Small icon indicating internal link              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Recommendation: Option A for clean look, Option B for visibility
```

### Wiki-Link States
```
NORMAL (view mode):
┌────────────────┐
│ Project Alpha  │
└────────────────┘
Color: Accent blue
Cursor: Default


HOVER:
┌────────────────┐
│ Project Alpha  │  ← Underline appears
└────────────────┘    Background subtle highlight
Cursor: Pointer


EDITING (cursor inside):
┌──────────────────┐
│[[Project Alpha]]│  ← Brackets visible
└──────────────────┘    Can edit text
                        Can delete whole link


BROKEN (page doesn't exist):
┌────────────────┐
│ Project Alpha  │  ← Dashed underline
└────────────────┘    Different color (muted or orange)
                      Click creates new page
```

### Trigger and Autocomplete
```
STEP 1: User types [[
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Working on [[|                                                  │
│             ↑                                                    │
│             Cursor here, autocomplete triggered                  │
│                                                                  │
│  ┌────────────────────────────────────────┐                      │
│  │                                        │                      │
│  │  📝 Recent                             │                      │
│  │  ─────────────────────────────────     │                      │
│  │  📄 Project Alpha                      │                      │
│  │  📄 Meeting Notes                      │                      │
│  │  📄 Weekly Review                      │                      │
│  │                                        │                      │
│  │  📁 All Pages                          │                      │
│  │  ─────────────────────────────────     │                      │
│  │  📄 2024 Goals                         │                      │
│  │  📄 Book Notes                         │                      │
│  │  📄 Ideas                              │                      │
│  │                                        │                      │
│  └────────────────────────────────────────┘                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘


STEP 2: User types to filter
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Working on [[proj|                                              │
│                                                                  │
│  ┌────────────────────────────────────────┐                      │
│  │                                        │                      │
│  │  📄 Project Alpha                ← Match                      │
│  │  📄 Project Beta                 ← Match                      │
│  │  📄 Side Project Ideas           ← Match                      │
│  │                                        │                      │
│  │  ─────────────────────────────────     │                      │
│  │  ➕ Create "proj"                ← Create new                 │
│  │                                        │                      │
│  └────────────────────────────────────────┘                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘


STEP 3: User selects option (Enter or click)
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Working on [[Project Alpha]]|                                   │
│                              ↑                                   │
│                              Cursor after link                   │
│                              Autocomplete closes                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Autocomplete Menu Structure
```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  🔍  Search pages...                              ✕            │
│                                                                │
│  ────────────────────────────────────────────────────────────  │
│                                                                │
│  📝 Recent                                                     │
│  ────────────────────────────────────────────────────────────  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  📄  Project Alpha                                       │  │
│  │      Last edited 2 hours ago                             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  │  ← Selected
│  │▓ 📄  Meeting Notes                                      ▓│  │
│  │▓     Last edited yesterday                              ▓│  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│     📄  Weekly Review                                          │
│         Last edited 3 days ago                                 │
│                                                                │
│  ────────────────────────────────────────────────────────────  │
│                                                                │
│  ➕  Create new page                                           │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Navigation:
- Arrow Up/Down: Move selection
- Enter: Select highlighted option
- Escape: Close menu
- Tab: Select and continue typing
- Click: Select option
```

### Autocomplete Item Structure
```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   📄  Project Alpha                                              │
│       Last edited 2 hours ago                                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Elements:
- Icon: 📄 (page) or type-specific icon
- Title: Page name (matches are highlighted)
- Metadata: Last edited time

With search highlighting:
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   📄  [Proj]ect Alpha                                            │
│       └──┬──┘                                                    │
│          └── Matched portion highlighted/bold                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Create New Page Option
```
When typed text doesn't match any existing page:

┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  [[My New Idea|                                                │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                                                          │  │
│  │  No matching pages found                                 │  │
│  │                                                          │  │
│  │  ──────────────────────────────────────────────────────  │  │
│  │                                                          │  │
│  │  ➕  Create "My New Idea"                                │  │
│  │      New page will be created                            │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Behavior on select:
1. Link is inserted: [[My New Idea]]
2. Page is NOT created yet (lazy creation)
3. Link shows as "broken" style (dashed underline)
4. Clicking link later creates the page
```

### Click Behavior
```
CLICK ON EXISTING PAGE LINK:
[[Project Alpha]] (exists)
        │
        │  Click
        ▼
Navigate to Project Alpha page
(Or open in split panel, depending on context)


CLICK ON NON-EXISTENT PAGE LINK:
[[My New Idea]] (doesn't exist)
        │
        │  Click
        ▼
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  Create "My New Idea"?                                         │
│                                                                │
│  This page doesn't exist yet.                                  │
│                                                                │
│             [Cancel]    [Create Page]                          │
│                                                                │
└────────────────────────────────────────────────────────────────┘

OR directly create and navigate (simpler UX)
```

### Keyboard Shortcuts for Wiki-Links
```
[[ → Trigger autocomplete
Escape → Close autocomplete
Arrow Up/Down → Navigate options
Enter → Select option
Tab → Select and continue
Backspace (on empty [[ ) → Remove trigger, close menu

When cursor is on a wiki-link:
Cmd/Ctrl + Click → Open in new tab/panel
Cmd/Ctrl + Enter → Open link (when selected)
```

## Tags

### Syntax
```
INPUT (what user types):
#work #productivity #wins

RENDERED (what user sees):
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Great progress today  #work  #productivity  #wins               │
│                        └─┬──┘ └─────┬──────┘ └─┬──┘              │
│                          └──────────┴──────────┴── Styled tags   │
│                              Clickable                           │
│                              Distinct from text                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Visual Styling
```
OPTION A: Colored text (minimal)
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Great progress today #work #productivity #wins                  │
│                       └──────────┬──────────────┘                │
│                                  └── Accent color, same size     │
│                                      Hash symbol visible         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘


OPTION B: Pill/badge style (recommended)
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Great progress today  ┌──────┐ ┌─────────────┐ ┌──────┐         │
│                        │#work │ │#productivity│ │#wins │         │
│                        └──────┘ └─────────────┘ └──────┘         │
│                            ├── Background: Light accent          │
│                            ├── Border-radius: 12px (pill)        │
│                            ├── Padding: 2px 8px                  │
│                            └── Font-size: Slightly smaller       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘


OPTION C: Subtle background
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Great progress today ░#work░ ░#productivity░ ░#wins░            │
│                       └──────────────┬──────────────────┘        │
│                                      └── Very light background   │
│                                          Rounded corners         │
│                                          Less prominent          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Recommendation: Option B for visibility and clickability
```

### Tag States
```
NORMAL:
┌────────┐
│ #work  │
└────────┘
Background: Light accent
Color: Accent text
Cursor: Default


HOVER:
┌────────┐
│ #work  │  ← Darker background
└────────┘    Cursor: Pointer


EDITING (cursor inside):
#work|
     ↑
     Can edit tag text
     No pill styling until complete


ACTIVE (filtered by this tag):
┌────────┐
│▓#work▓▓│  ← Filled/selected appearance
└────────┘    Indicates active filter
```

### Tag Rules
```
VALID TAGS:
#work           ← Simple word
#project-alpha  ← Hyphenated
#2024goals      ← Numbers allowed
#AI_ML          ← Underscores allowed
#CamelCase      ← Mixed case preserved

INVALID / END OF TAG:
#work.          ← Period ends tag → #work + "."
#work,          ← Comma ends tag → #work + ","
#work thing     ← Space ends tag → #work + " thing"
#work(note)     ← Paren ends tag → #work + "(note)"
#123            ← Numbers only (depends on design choice)

TAG NAME RULES:
- Must start with letter or number after #
- Can contain: letters, numbers, hyphens, underscores
- Cannot contain: spaces, punctuation (except - and _)
- Case-sensitive or case-insensitive (design choice)
- Recommended: case-insensitive storage, preserve display case
```

### Trigger and Autocomplete
```
STEP 1: User types #
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Great progress today #|                                         │
│                       ↑                                          │
│                       Autocomplete triggered                     │
│                                                                  │
│  ┌────────────────────────────────────────┐                      │
│  │                                        │                      │
│  │  🏷️ Recent Tags                        │                      │
│  │  ─────────────────────────────────     │                      │
│  │  #work                          (42)   │                      │
│  │  #personal                      (28)   │                      │
│  │  #ideas                         (15)   │                      │
│  │  #productivity                  (12)   │                      │
│  │  #wins                          (8)    │                      │
│  │                                        │                      │
│  └────────────────────────────────────────┘                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘


STEP 2: User types to filter
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Great progress today #wo|                                       │
│                                                                  │
│  ┌────────────────────────────────────────┐                      │
│  │                                        │                      │
│  │  #work                          (42)   │  ← Matches "wo"      │
│  │  #workout                       (5)    │  ← Matches "wo"      │
│  │                                        │                      │
│  │  ─────────────────────────────────     │                      │
│  │  ➕ Create #wo                         │                      │
│  │                                        │                      │
│  └────────────────────────────────────────┘                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘


STEP 3: User selects or continues typing
Option A: Select from list → #work inserted
Option B: Keep typing → #workout| (can still select)
Option C: Press space → #wo created as new tag
```

### Tag Autocomplete Menu
```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  🏷️ Tags                                                       │
│                                                                │
│  ────────────────────────────────────────────────────────────  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  │  ← Selected
│  │▓ #work                                           (42)   ▓│  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│     #personal                                       (28)       │
│                                                                │
│     #ideas                                          (15)       │
│                                                                │
│     #productivity                                   (12)       │
│                                                                │
│     #wins                                           (8)        │
│                                                                │
│  ────────────────────────────────────────────────────────────  │
│                                                                │
│  ➕ Create new tag                                             │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Elements per item:
- Tag name with # prefix
- Usage count (how many times used across all entries)
```

### Click Behavior
```
CLICK ON TAG:
#work
   │
   │  Click
   ▼
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  Filter by #work                                               │
│                                                                │
│  ────────────────────────────────────────────────────────────  │
│                                                                │
│  42 entries with this tag                                      │
│                                                                │
│  📓 Dec 9, 2024 - "Great progress today..."                    │
│  📓 Dec 5, 2024 - "Wrapped up the sprint..."                   │
│  📓 Dec 2, 2024 - "Started new project..."                     │
│  📄 Meeting Notes - Q3 Planning                                │
│  ...                                                           │
│                                                                │
│             [Clear Filter]    [Open Tag Page]                  │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Options:
A. Show popover with filtered results (above)
B. Navigate to tag page showing all entries
C. Apply filter to current view
```

### Keyboard Shortcuts for Tags
```
# → Trigger autocomplete
Escape → Close autocomplete
Arrow Up/Down → Navigate options
Enter → Select option
Space → Complete current tag (create if new)
Tab → Select and continue

When cursor is on a tag:
Cmd/Ctrl + Click → Open tag page in new tab
Backspace (at start of tag) → Delete entire tag
```

## Shared Autocomplete Behavior

### Position and Sizing
```
Autocomplete menu positioning:

┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Working on [[proj|                                              │
│             └───────┬────────────────────────┐                   │
│                     │                        │                   │
│                     │  ┌─────────────────┐   │                   │
│                     │  │ Autocomplete    │   │                   │
│                     │  │ menu appears    │   │                   │
│                     └─▶│ below trigger   │   │                   │
│                        │                 │   │                   │
│                        └─────────────────┘   │                   │
│                                              │                   │
│                                              │                   │
└──────────────────────────────────────────────┴───────────────────┘

Positioning rules:
- Appears below cursor/trigger by default
- Flips above if not enough space below
- Aligned to start of trigger text
- Max-height: 300px (scrollable)
- Min-width: 200px
- Max-width: 350px
```

### Fuzzy Matching
```
Search: "prjalph"

Results (fuzzy match):
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  📄  [Pr]oject [Al]p[h]a                    ← Matched chars    │
│      Score: 0.85                               highlighted     │
│                                                                │
│  📄  [Pr]oject [Al]p[h]abetical             ← Lower score      │
│      Score: 0.72                                               │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Fuzzy matching features:
- Match non-consecutive characters
- Rank by match quality
- Highlight matched portions
- Prioritize start-of-word matches
```

### Empty State
```
When no matches found:

┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  [[xyzabc123|                                                  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                                                          │  │
│  │            No pages found                                │  │
│  │                                                          │  │
│  │  ──────────────────────────────────────────────────────  │  │
│  │                                                          │  │
│  │  ➕  Create "xyzabc123"                                  │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Tiptap Extension Implementation

### WikiLink Extension
```typescript
// WikiLink Node Extension
import { Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from 'prosemirror-state';
import Suggestion from '@tiptap/suggestion';

export const WikiLink = Node.create({
  name: 'wikiLink',

  group: 'inline',
  inline: true,
  selectable: true,
  atom: true,  // Treated as single unit

  addAttributes() {
    return {
      href: {
        default: null,
      },
      title: {
        default: null,
      },
      exists: {
        default: true,  // Whether linked page exists
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-wiki-link]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(
        { 'data-wiki-link': '' },
        HTMLAttributes,
        {
          class: `wiki-link ${HTMLAttributes.exists ? '' : 'wiki-link-broken'}`,
        }
      ),
      HTMLAttributes.title,
    ];
  },

  addKeyboardShortcuts() {
    return {
      // Handle backspace on wiki-link
      Backspace: () => {
        // Delete entire link if cursor at start
        return false;
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: '[[',
        pluginKey: new PluginKey('wikiLinkSuggestion'),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({
              type: 'wikiLink',
              attrs: {
                href: props.href,
                title: props.title,
                exists: props.exists,
              },
            })
            .run();
        },
        items: ({ query }) => {
          // Return filtered pages
          return searchPages(query);
        },
        render: () => {
          // Return popup component
          return {
            onStart: (props) => { /* show popup */ },
            onUpdate: (props) => { /* update popup */ },
            onExit: () => { /* hide popup */ },
            onKeyDown: (props) => { /* handle keys */ },
          };
        },
      }),
    ];
  },
});
```

### Tag Extension
```typescript
// Tag Node Extension
import { Node, mergeAttributes } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';

export const Tag = Node.create({
  name: 'tag',

  group: 'inline',
  inline: true,
  selectable: true,
  atom: true,

  addAttributes() {
    return {
      tag: {
        default: null,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-tag]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(
        { 'data-tag': '' },
        HTMLAttributes,
        { class: 'tag' }
      ),
      `#${HTMLAttributes.tag}`,
    ];
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: '#',
        pluginKey: new PluginKey('tagSuggestion'),
        allowSpaces: false,
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({
              type: 'tag',
              attrs: {
                tag: props.tag,
              },
            })
            .insertContent(' ')  // Add space after tag
            .run();
        },
        items: ({ query }) => {
          return searchTags(query);
        },
        render: () => {
          return {
            onStart: (props) => { /* show popup */ },
            onUpdate: (props) => { /* update popup */ },
            onExit: () => { /* hide popup */ },
            onKeyDown: (props) => { /* handle keys */ },
          };
        },
      }),
    ];
  },
});
```

## CSS Styling
```css
/* Wiki-Link Styles */
.wiki-link {
  color: var(--accent-color);
  text-decoration: none;
  cursor: pointer;
  border-radius: 2px;
  transition: background-color 150ms ease;
}

.wiki-link:hover {
  text-decoration: underline;
  background-color: var(--accent-bg-subtle);
}

.wiki-link-broken {
  color: var(--warning-color);
  text-decoration-style: dashed;
}

.wiki-link-broken:hover {
  text-decoration: underline;
  text-decoration-style: dashed;
}

/* Tag Styles */
.tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  margin: 0 2px;
  background-color: var(--tag-bg);
  color: var(--tag-color);
  border-radius: 12px;
  font-size: 0.9em;
  cursor: pointer;
  transition: background-color 150ms ease;
}

.tag:hover {
  background-color: var(--tag-bg-hover);
}

/* Autocomplete Menu */
.autocomplete-menu {
  position: absolute;
  background: var(--popover-bg);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  max-height: 300px;
  overflow-y: auto;
  z-index: 1000;
  min-width: 200px;
  max-width: 350px;
}

.autocomplete-item {
  padding: 8px 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}

.autocomplete-item:hover,
.autocomplete-item.selected {
  background-color: var(--hover-bg);
}

.autocomplete-item-icon {
  font-size: 16px;
  width: 20px;
  text-align: center;
}

.autocomplete-item-title {
  flex: 1;
  font-size: 14px;
}

.autocomplete-item-meta {
  font-size: 12px;
  color: var(--text-secondary);
}

.autocomplete-match {
  font-weight: 600;
  color: var(--accent-color);
}

.autocomplete-create {
  border-top: 1px solid var(--border-color);
  color: var(--accent-color);
}
```

## Data Structures
```typescript
// Wiki-Link
interface WikiLinkData {
  href: string;      // Page ID or slug
  title: string;     // Display text
  exists: boolean;   // Whether page exists
}

// Tag
interface TagData {
  tag: string;       // Tag name (without #)
  count?: number;    // Usage count (for autocomplete)
}

// Autocomplete suggestion
interface PageSuggestion {
  id: string;
  title: string;
  type: 'page' | 'note' | 'journal';
  lastEdited: string;
  matchScore: number;
}

interface TagSuggestion {
  tag: string;
  count: number;
  matchScore: number;
}
```

## Component Hierarchy
```
Editor (Tiptap)
├── Extensions
│   ├── WikiLink (Node)
│   │   └── SuggestionPlugin
│   │       └── WikiLinkAutocomplete (React)
│   │           ├── SearchInput
│   │           ├── RecentSection
│   │           ├── ResultsList
│   │           │   └── ResultItem (×n)
│   │           └── CreateOption
│   │
│   └── Tag (Node)
│       └── SuggestionPlugin
│           └── TagAutocomplete (React)
│               ├── ResultsList
│               │   └── TagItem (×n)
│               └── CreateOption
│
└── EditorContent
    ├── WikiLinkNode (rendered)
    └── TagNode (rendered)
```

## Accessibility
```
Wiki-Link:
- role="link"
- tabindex="0"
- aria-label="Link to Project Alpha"
- Enter/Space to activate
- Announced by screen reader as link

Tag:
- role="button"
- tabindex="0"
- aria-label="Tag: work, click to filter"
- Enter/Space to activate
- Announced as button

Autocomplete Menu:
- role="listbox"
- aria-label="Page suggestions" / "Tag suggestions"
- aria-expanded="true/false"
- aria-activedescendant points to selected item

Autocomplete Item:
- role="option"
- aria-selected="true/false"
- Announced: "Project Alpha, page, last edited 2 hours ago"
```

## Keyboard Navigation Summary
```
WIKI-LINKS:
┌─────────────────────────────────────────────────────────────────┐
│  Action                    │  Shortcut                         │
├────────────────────────────┼───────────────────────────────────┤
│  Trigger autocomplete      │  [[                               │
│  Navigate options          │  Arrow Up/Down                    │
│  Select option             │  Enter                            │
│  Close menu                │  Escape                           │
│  Open link (from editor)   │  Cmd/Ctrl + Click                 │
│  Delete link               │  Backspace (when selected)        │
└─────────────────────────────────────────────────────────────────┘

TAGS:
┌─────────────────────────────────────────────────────────────────┐
│  Action                    │  Shortcut                         │
├────────────────────────────┼───────────────────────────────────┤
│  Trigger autocomplete      │  #                                │
│  Navigate options          │  Arrow Up/Down                    │
│  Select option             │  Enter                            │
│  Complete & create new     │  Space                            │
│  Close menu                │  Escape                           │
│  Open tag filter           │  Cmd/Ctrl + Click                 │
│  Delete tag                │  Backspace (when selected)        │
└─────────────────────────────────────────────────────────────────┘
```

## Integration Points
```
WITH JOURNAL EDITOR:
- Wiki-links and tags work in journal entries
- Same behavior in note panels
- Autocomplete consistent across all editors

WITH AI CONNECTIONS:
- Wiki-links increase connection score
- Shared tags boost semantic similarity
- Linked pages appear in connections

WITH SIDEBAR:
- Clicking tag can filter sidebar content
- Clicking wiki-link can navigate or open panel

WITH SIMPLE/FOCUS MODES:
- Features work in all view modes
- Autocomplete adapts to available space
```

## Expected Output

After implementing this prompt:
1. Type `[[` triggers page autocomplete
2. Type `#` triggers tag autocomplete
3. Autocomplete shows recent/matching items
4. Can create new pages/tags from menu
5. Wiki-links render with accent color
6. Broken links show dashed underline
7. Tags render as colored pills
8. Clicking wiki-link navigates to page
9. Clicking tag filters content
10. Fuzzy search matching works
11. Keyboard navigation in autocomplete
12. Proper accessibility attributes
13. Works in journal and note editors

## Do Not Include Yet

- Backlinks panel (showing pages that link to current)
- Graph view of connections
- Tag management page
- Bulk tag editing

Focus on inline wiki-link and tag functionality.

Implementation Notes
TechniqueWhyTiptap SuggestionBuilt-in autocomplete supportProseMirror NodeTreat link/tag as atomic unitFuzzy searchFlexible matchingDebounced searchPerformance for large page listsCSS transitionsSmooth hover states
Expected Outcome
After implementing this prompt, you should have:

Working [[wiki-link]] syntax with autocomplete
Working #tag syntax with autocomplete
Visual distinction for both element types
Broken link indication
Click navigation/filtering
Keyboard-accessible menus
Fuzzy search matching