# Tag-notes sidebar panel — compact redesign

**Date:** 2026-06-12
**Branch:** `tag-notes-sidebar-redesign`
**Scope:** Visual-only restyle of the existing tag drill-down panel. No wiring, IPC, contract, hook, or data changes.

## Context

Clicking a tag in `SidebarTagList` already drives `SidebarDrillDownProvider.openTag` →
`SidebarDrillDownContainer` (slide animation) → `TagDetailView`, which lists the tag's notes
in the sidebar. The feature works; it is just visually loose:

- Header is two lines (tag name + "N notes" below).
- `NoteItem` rows are two lines (title + date), ~40px tall, with generous padding.

Goal: make the panel compact, clean, and UX-friendly while keeping **all** current behavior.

## Decisions (locked with user)

- **Restyle only** — keep slide-in drill-down + every action.
- **Single-line note rows** — icon + title on one line, relative date right-aligned.
- **Keep:** sort control, pin/unpin, tag actions `⋯` menu (rename / color / delete), note count.
- **Loading:** 3 skeleton rows matching the new row layout (replaces "Loading notes…" text).

## Files touched

- `apps/desktop/src/renderer/src/components/sidebar/tag-detail-view.tsx`
  - `TagDetailView` — header + section structure restyle.
  - `NoteItem` — two-line → single-line.
  - Add a small local `NoteRowSkeleton` for the loading state.
- (No changes to `sidebar-drill-down-container.tsx`, `sidebar-drill-down.tsx`,
  `use-tag-detail.ts`, `tags-service.ts`, contracts, or dialogs.)

## Layout spec

### Header — collapse 2 lines → 1 row (~36px)

```
[‹]  ● design-systems · 12              ⋯
─────────────────────────────────────────
```

- Back button: ghost, `size-6` (was `h-7 w-7`).
- Color dot: `size-2.5`, current style (bg = tag background, ring = tag text color).
- Tag name: keep hierarchy rendering (`parent / leaf`, parent muted, leaf normal weight).
- Count: inline muted `· {count}` after the name. Full "{count} notes" string moves to the
  tag name `title` tooltip (reuse existing i18n; no second line).
- Overflow `⋯`: ghost `size-6`, far end.
- `border-b` lightened (`border-b border-border/60`).

### Pinned section (only when `pinnedNotes.length > 0`)

```
PINNED                                       ← text-[10px] uppercase tracking-wide muted, px-2 py-1
📄 Color tokens spec                     📌
📄 Spacing scale                         📌
──────────────────────────────────────────  ← hairline (border-border/50), my-1.5
```

### All-notes header + sort (one slim row)

```
ALL NOTES                                ⇅   ← label left, SortDropdown right (size-5 ghost)
```

- Sort options unchanged (Recent / Created / Alphabetical), same `setSortBy`.

### Note row — single-line (~28px), the core change

- Container: `group/noteitem flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50
  cursor-pointer`, keeps `role="button"`, `tabIndex={0}`, Enter/Space handler.
- Icon: emoji via `NoteIconDisplay` or `FileText` `size-3.5 text-muted-foreground`, `shrink-0`.
- Title: `flex-1 min-w-0 truncate text-[13px] leading-5`.
- Right cluster (`ml-auto flex items-center gap-1`, fixed min-width to avoid layout shift):
  - Relative date: `text-[10px] tabular-nums text-muted-foreground/70` (existing `formatDate`).
  - Pin toggle: `size-5` button.
    - Unpinned: `opacity-0 group-hover/noteitem:opacity-100`; date visible at rest.
    - Pinned: filled pin always visible, tag/primary tint; click = unpin.
  - Reserve the pin slot width at rest so hover reveal causes no horizontal jump.

### States

- **Loading:** `NoteRowSkeleton` ×3 — `flex items-center gap-2 px-2 py-1` with an `animate-pulse`
  `size-3.5` muted square + a muted bar (`h-3 w-3/4 rounded`).
- **Empty (`count === 0`):** keep existing compact centered copy + i18n keys.
- **Error:** keep existing compact centered destructive text.

## Principles (frontend-design)

- One accent only = the tag color (dot + pinned pin tint). No new borders/gradients/shadows.
- Tight vertical rhythm; tabular-nums dates; hover-reveal affordances.
- Type scale matches `SidebarTagList` (`text-[11px]/[13px]`, `size-3.5` icons).
- RTL-safe: use logical classes (`ms-*`/`me-*`, `ps-*`/`pe-*`) for any new spacing.

## Out of scope

Drill-down slide animation, `useTagDetail`, `tagsService`, contracts/IPC, rename/delete/color
dialogs, the tag tree in `SidebarTagList`. Behavior is identical; only markup + classes change.

## Verification

- `pnpm --filter @memry/desktop typecheck:web`
- `pnpm lint` (RTL logical-class rule, no `console.*`)
- Existing `sidebar-tag-list.test.tsx` stays green (untouched behavior).
- Add a light render test for `TagDetailView` asserting: renders note titles, pin toggle present,
  sort control present, skeleton on loading — locks structure without pixel assertions.
- Visual confirmation in the running app (`/design-review`): density, hover, pinned tint, RTL.
- `pnpm docs:impact --base <base> --strict` (renderer change; expect no doc routing, restyle only).
