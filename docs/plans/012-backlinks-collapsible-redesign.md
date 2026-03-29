# 012 — Backlinks: Collapsible Per-Note Mentions

## Problem

Current backlinks view shows a flat card list — one card per referring note, displaying only the **first** mention snippet. If Note A links to the current note 5 times, you only see 1 snippet. The rest are hidden behind an invisible data model.

## New Design

Group by referring note. Each note is a collapsible disclosure. Under it, every line that contains a `[[wikilink]]` to the current note is listed individually.

---

## Visual Spec

```
┌─────────────────────────────────────────────────────────┐
│  🔗 12 backlinks                          Sort: Recent ▾│
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ▾ 📄 Weekly Standup Notes                          3×  │
│  ┊                                                      │
│  ┊  "…discussed the approach in [[Current Note]]        │
│  ┊   and agreed to move forward…"                       │
│  ┊                                                      │
│  ┊  "…@Kaan will sync with [[Current Note]]             │
│  ┊   owner before Friday…"                              │
│  ┊                                                      │
│  ┊  "…see also [[Current Note]] for the                 │
│  ┊   updated architecture diagram"                      │
│  ┊                                                      │
│  ▾ 📄 Product Roadmap Q2                            1×  │
│  ┊                                                      │
│  ┊  "…[[Current Note]] is the key dependency            │
│  ┊   for the sync milestone…"                           │
│  ┊                                                      │
│  ▸ 📄 Research: CRDT Merge Strategies               4×  │
│                                                         │
│  ▸ 📄 Architecture Decision Records                 2×  │
│                                                         │
│  ▸ 📄 Sprint Retro — Feb 18                         1×  │
│                                                         │
│  ── Show 7 more notes ──                                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Anatomy Breakdown

```
┌─ Section Header ─────────────────────────────────┐
│  [BacklinksIcon]  "12 backlinks"     [Sort ▾]    │
│                                                   │
│  Entire section collapsible via header click.     │
│  Count = total referring notes, not mentions.     │
└───────────────────────────────────────────────────┘

┌─ Note Row (collapsed) ───────────────────────────┐
│  ▸  [emoji|FileIcon]  Note Title             3×  │
│                                                   │
│  Click chevron or row → expand.                   │
│  Click title text → navigate to note.             │
│  "3×" = mention count badge, right-aligned.       │
│  Entire row: hover:bg-surface-active/50           │
└───────────────────────────────────────────────────┘

┌─ Note Row (expanded) ────────────────────────────┐
│  ▾  [emoji|FileIcon]  Note Title             3×  │
│  ┊                                                │
│  ┊  ┌─ Mention Line ──────────────────────────┐  │
│  ┊  │ "…context before [[Link]] after…"       │  │
│  ┊  │                                         │  │
│  ┊  │ line-clamp-2, highlight [[wikilink]]    │  │
│  ┊  │ text-text-tertiary, text-xs/[17px]      │  │
│  ┊  │ click → navigate to note + scroll to    │  │
│  ┊  │ the specific mention position            │  │
│  ┊  └─────────────────────────────────────────┘  │
│  ┊                                                │
│  ┊  ┌─ Mention Line ──────────────────────────┐  │
│  ┊  │ "…another line referencing [[Link]]…"   │  │
│  ┊  └─────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘

┌─ Show More ──────────────────────────────────────┐
│  "Show 7 more notes"                              │
│                                                   │
│  Centered, text-xs, text-muted-foreground.        │
│  Loads next batch (initialCount = 5).             │
└───────────────────────────────────────────────────┘
```

---

## Interaction Model

| Action | Target | Result |
|--------|--------|--------|
| Click chevron / row bg | Note row | Toggle expand/collapse mentions |
| Click note title text | Title `<span>` | Navigate to that note |
| Click mention snippet | Mention line | Navigate to note + scroll to mention position |
| Hover mention | Mention line | Subtle bg highlight (`surface-active/30`) |
| Click `Sort ▾` | Sort dropdown | Change sort order (recent / A-Z / most mentions) |
| Click `Show N more` | Footer button | Reveal next batch of note rows |

### Keyboard

| Key | Context | Action |
|-----|---------|--------|
| `Enter` / `Space` | Focused note row | Toggle expand |
| `Enter` | Focused mention | Navigate to source |
| `ArrowDown` / `ArrowUp` | Within section | Move focus between rows |

---

## Expand Behavior

- **Default**: First 2 notes expanded, rest collapsed.
- **Single-mention notes**: Auto-expanded (no point collapsing 1 line).
- **Expand all / Collapse all**: Not needed for v1. Revisit if users have 20+ referring notes.

---

## Styling Details

### Note Row (header)

```
Container:
  py-1.5 px-2
  rounded-md
  hover:bg-surface-active/50
  cursor-pointer
  transition-colors duration-150

Chevron:
  size-3.5
  text-text-tertiary
  transition-transform duration-200
  rotate-0 (collapsed) → rotate-90 (expanded)

Icon/Emoji:
  size-3.5 (FileText icon) or text-sm (emoji)
  text-text-tertiary (icon only)
  shrink-0

Title:
  text-[13px]/4
  font-medium
  text-text-bright
  truncate
  flex-1

Mention Count Badge:
  text-[11px]
  text-text-tertiary
  tabular-nums
  shrink-0
```

### Mention Line

```
Container:
  ml-5 (align under title, past chevron)
  pl-3
  border-l border-border/30  (the "┊" connector line)
  py-1.5

Snippet text:
  text-xs/[17px]
  text-text-tertiary
  line-clamp-2

Highlighted [[wikilink]]:
  text-muted-foreground (slightly brighter than surrounding)
  — reuse existing BacklinkSnippet WIKILINK_RE logic

Hover:
  bg-surface-active/30 rounded
  cursor-pointer
```

### Connector Line

The `border-l` on mention containers creates a subtle tree-line visual that connects mentions to their parent note. It stops at the last mention (use `last:border-l-transparent` or conditional class).

---

## Sort Behavior

| Sort | Primary key | Notes |
|------|-------------|-------|
| Recent | `max(mentions[].date)` per note | Most-recently-mentioned note first |
| A-Z | `noteTitle.localeCompare()` | Alphabetical by referring note |
| Most mentions | `mentions.length` desc | Heaviest linkers first |

---

## Data Model Changes

No schema changes needed. Existing `Backlink` type already has:

```ts
interface Backlink {
  id: string
  noteId: string
  noteTitle: string
  folder?: string
  date: Date
  mentions: Mention[]  // ← already supports multiple
}

interface Mention {
  id: string
  snippet: string
  linkStart: number
  linkEnd: number
}
```

Currently `BacklinkCard` renders `mentions[0]` only. New design renders all `mentions[]`.

**Optional addition** for scroll-to-mention:

```ts
interface Mention {
  // existing
  id: string
  snippet: string
  linkStart: number
  linkEnd: number
  // new (optional, for scroll-to-mention on click)
  blockId?: string     // BlockNote block ID containing the mention
  lineNumber?: number  // fallback: line number in document
}
```

---

## Component Changes

### Keep
- `BacklinksSection` — outer container, header, sort, show-more (restructure internals)
- `BacklinkSnippet` — reuse for rendering mention text with `[[wikilink]]` highlights
- `BacklinksLoadingState` — keep as-is
- `types.ts` — extend `Mention` if adding `blockId`

### Rename / Refactor
- `BacklinkCard` → `BacklinkNoteRow` — becomes the collapsible note-level row
  - Renders chevron + icon + title + mention count
  - Manages own expanded/collapsed state
  - Maps over `mentions[]` to render `BacklinkSnippet` items

### New (optional)
- `BacklinkMentionItem` — if mention lines need click handlers + hover states, extract to own component. Otherwise inline in `BacklinkNoteRow`.

---

## Empty / Edge States

| State | Display |
|-------|---------|
| Loading | Existing spinner (BacklinksLoadingState) |
| No backlinks | Section hidden entirely (existing behavior) |
| 1 backlink, 1 mention | Single auto-expanded row, no sort dropdown |
| 1 backlink, N mentions | Single auto-expanded row with all mentions shown |
| Note deleted after indexing | Show title in `text-text-tertiary` + strikethrough, non-clickable |

---

## Motion

- Chevron rotation: `transition-transform duration-200`
- Expand/collapse: height animation via `grid-rows` trick or `data-[state=open]` with CSS
- Mention lines stagger-in on expand: `animate-in fade-in-0 slide-in-from-top-1` with 30ms stagger per item (max 5 items animated, rest instant)

---

## Accessibility

- Section: `role="region"` + `aria-label="Backlinks"`
- Note rows: `role="button"` + `aria-expanded` + `aria-controls` pointing to mention list
- Mention list: `role="list"` + `role="listitem"` per mention
- Focus management: tab through note rows, enter to expand, tab into mentions when expanded
