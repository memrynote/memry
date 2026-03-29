# Memry Design Tokens

Single source of truth: [`apps/desktop/src/renderer/src/assets/base.css`](../apps/desktop/src/renderer/src/assets/base.css)

Tailwind v4 `@theme inline` maps every CSS variable to a Tailwind utility class. Density config lives in [`hooks/use-display-density.ts`](../apps/desktop/src/renderer/src/hooks/use-display-density.ts).

## Philosophy

**"Warm Utility"** — paper-inspired surfaces, serif editorial typography, flat-first shadows, purposeful motion.

| Theme | Selector | Character |
|-------|----------|-----------|
| Warm (default) | `:root` | Beige paper, warm greys, near-black text |
| White | `.white` | Notion-inspired clean white, cooler neutrals |
| Dark | `.dark` | Neutral charcoal, muted warm text |

User-customizable accent via `--tint` derived from `--user-accent-color` with `color-mix()`.

---

## How to Use

**CSS variable** — use anywhere:
```css
background-color: var(--background);
```

**Tailwind utility** — `@theme inline` maps `--color-background: var(--background)`, enabling:
```html
<div class="bg-background text-foreground" />
```

**Theme switching** — controlled by class on `<html>`:
- Warm: no class (`:root`)
- White: `class="white"`
- Dark: `class="dark"`

**User accent** — injected at runtime as `--user-accent-color` on `:root`. Falls back to indigo `#6366f1`.

---

## Colors — Canvas

| Token | Warm | White | Dark | Tailwind | Usage |
|-------|------|-------|------|----------|-------|
| `--background` | `#f6f5f0` | `#ffffff` | `#191919` | `bg-background` | Page background |
| `--foreground` | `#1a1a1a` | `#37352f` | `#bcbab6` | `text-foreground` | Primary text |
| `--surface` | `#efefe9` | `#f7f6f3` | `#222222` | `bg-surface` | Panels, sidebar bg |
| `--surface-active` | `#e4e4de` | `#efedea` | `#2a2a2a` | `bg-surface-active` | Hover state bg |

## Colors — Typography

| Token | Warm | White | Dark | Tailwind | Usage |
|-------|------|-------|------|----------|-------|
| `--text-primary` | `#1a1a1a` | `#37352f` | `#bcbab6` | `text-text-primary` | Titles, headers |
| `--text-secondary` | `#4a4a4a` | `#6b6966` | `#bcbab6` | `text-text-secondary` | Body, sidebar items |
| `--text-tertiary` | `#8c8c8c` | `#9b9a97` | `#ada9a3` | `text-text-tertiary` | Metadata, dates, icons |

## Colors — UI Semantic (Shadcn)

| Token | Warm | White | Dark | Tailwind |
|-------|------|-------|------|----------|
| `--primary` | `#1a1a1a` | `#37352f` | `#e8e6e1` | `bg-primary` / `text-primary` |
| `--primary-foreground` | `#f6f5f0` | `#ffffff` | `#191919` | `text-primary-foreground` |
| `--secondary` | `#efefe9` | `#f7f6f3` | `#222222` | `bg-secondary` |
| `--secondary-foreground` | `#1a1a1a` | `#37352f` | `#bcbab6` | `text-secondary-foreground` |
| `--muted` | `#efefe9` | `#f7f6f3` | `#222222` | `bg-muted` |
| `--muted-foreground` | `#4a4a4a` | `#6b6966` | `#ada9a3` | `text-muted-foreground` |
| `--accent` | `#efefe9` | `#f7f6f3` | `#2a2a2a` | `bg-accent` |
| `--accent-foreground` | `#1a1a1a` | `#37352f` | `#bcbab6` | `text-accent-foreground` |
| `--popover` | `#f6f5f0` | `#ffffff` | `#1e1e1e` | `bg-popover` |
| `--popover-foreground` | `#1a1a1a` | `#37352f` | `#bcbab6` | `text-popover-foreground` |
| `--card` | `#ffffff` | `#ffffff` | `#222222` | `bg-card` |
| `--card-foreground` | `#1a1a1a` | `#37352f` | `#bcbab6` | `text-card-foreground` |
| `--border` | `#e4e4de` | `#e3e2e0` | `#333333` | `border-border` |
| `--input` | `#e4e4de` | `#e3e2e0` | `#333333` | `border-input` |
| `--ring` | `#8c8c8c` | `#9b9a97` | `#6b6b6b` | `ring-ring` |
| `--destructive` | `#dc2626` | `#e03e3e` | `#dc2626` | `bg-destructive` |
| `--destructive-foreground` | `#fafafa` | `#ffffff` | `#fafafa` | `text-destructive-foreground` |

## Colors — Accent Dots

Category dot indicators. Slightly brighter in dark mode for contrast.

| Token | Warm | White | Dark | Tailwind |
|-------|------|-------|------|----------|
| `--accent-cyan` | `#06b6d4` | `#0891b2` | `#22d3ee` | `text-accent-cyan` |
| `--accent-purple` | `#8b5cf6` | `#7c3aed` | `#a78bfa` | `text-accent-purple` |
| `--accent-green` | `#22c55e` | `#16a34a` | `#4ade80` | `text-accent-green` |
| `--accent-orange` | `#f97316` | `#ea580c` | `#fb923c` | `text-accent-orange` |

## Colors — Card Pastels

Semantic background tints for knowledge cards.

| Token | Warm | White | Dark | Domain |
|-------|------|-------|------|--------|
| `--card-sage` | `#e6efe6` | `#dbeddb` | `#1e261e` | Biology / Nature |
| `--card-rose` | `#efe6e6` | `#ffe2dd` | `#261e1e` | Economics / History |
| `--card-sand` | `#efebdd` | `#fdecc8` | `#26241e` | Cyber Security / General |
| `--card-lavender` | `#e6e0ef` | `#e8deee` | `#211e26` | Machine Learning |
| `--card-grey` | `#e0e0e0` | `#e3e2e0` | `#222222` | Unknown / Sort |

---

## User Tint System

Declared once across all themes. `--user-accent-color` is injected at runtime; defaults to indigo `#6366f1`.

| Token | Formula | Usage |
|-------|---------|-------|
| `--tint` | `var(--user-accent-color, #6366f1)` | Base accent color |
| `--tint-foreground` | `#ffffff` | Text on tint bg |
| `--tint-hover` | `color-mix(in srgb, var(--tint) 85%, black)` | Darkened hover state |
| `--tint-light` | `color-mix(in srgb, var(--tint) 15%, transparent)` | Subtle background tint |
| `--tint-lighter` | `color-mix(in srgb, var(--tint) 10%, transparent)` | Very subtle bg |
| `--tint-muted` | `color-mix(in srgb, var(--tint) 50%, transparent)` | Half-opacity accent |
| `--tint-ring` | `color-mix(in srgb, var(--tint) 30%, transparent)` | Focus ring color |
| `--tint-border` | `color-mix(in srgb, var(--tint) 50%, transparent)` | Accent border |

Tailwind: `bg-tint`, `text-tint-foreground`, `ring-tint-ring`, etc.

---

## Task Colors

### Priority

Same across warm/white. Dark mode adjusts high priority to `#fb923c` and reduces bg opacity to `0.1`.

| Token | Warm / White | Dark | Tailwind |
|-------|-------------|------|----------|
| `--task-priority-urgent` | `#ef4444` | `#ef4444` | `text-task-priority-urgent` |
| `--task-priority-urgent-bg` | `rgba(239,68,68,0.12)` | `rgba(239,68,68,0.1)` | `bg-task-priority-urgent-bg` |
| `--task-priority-high` | `#f97316` | `#fb923c` | `text-task-priority-high` |
| `--task-priority-high-bg` | `rgba(249,115,22,0.12)` | `rgba(249,115,22,0.1)` | `bg-task-priority-high-bg` |
| `--task-priority-medium` | `#a0a0a8` | `#a0a0a8` | `text-task-priority-medium` |
| `--task-priority-medium-bg` | `rgba(160,160,168,0.12)` | `rgba(160,160,168,0.1)` | `bg-task-priority-medium-bg` |
| `--task-priority-low` | `#50505a` | `#50505a` | `text-task-priority-low` |
| `--task-priority-low-bg` | `rgba(80,80,90,0.12)` | `rgba(80,80,90,0.1)` | `bg-task-priority-low-bg` |
| `--task-priority-none` | `#50505a` | `#50505a` | `text-task-priority-none` |
| `--task-priority-none-bg` | `rgba(80,80,90,0.12)` | `rgba(80,80,90,0.1)` | `bg-task-priority-none-bg` |

### Due Date Status

Dark mode uses lighter, more legible variants.

| Token | Warm / White | Dark | Tailwind |
|-------|-------------|------|----------|
| `--task-due-overdue` | `#dc2626` | `#f87171` | `text-task-due-overdue` |
| `--task-due-overdue-bg` | `#fef2f2` | `rgba(239,68,68,0.1)` | `bg-task-due-overdue-bg` |
| `--task-due-today` | `#d97706` | `#fbbf24` | `text-task-due-today` |
| `--task-due-today-bg` | `#fffbeb` | `rgba(217,119,6,0.1)` | `bg-task-due-today-bg` |
| `--task-due-tomorrow` | `#2563eb` | `#60a5fa` | `text-task-due-tomorrow` |
| `--task-due-tomorrow-bg` | `#eff6ff` | `rgba(37,99,235,0.1)` | `bg-task-due-tomorrow-bg` |
| `--task-due-upcoming` | `#4f46e5` | `#818cf8` | `text-task-due-upcoming` |

### Completion & UI Accents

| Token | Warm / White | Dark | Tailwind | Usage |
|-------|-------------|------|----------|-------|
| `--task-complete` | `#22c55e` | `#4ade80` | `bg-task-complete` | Done checkmark, progress bar fill |
| `--task-complete-bg` | `rgba(77,166,99,0.1)` | `rgba(77,166,99,0.15)` | `bg-task-complete-bg` | Done row bg |
| `--task-progress` | `#3b82f6` | `#60a5fa` | `bg-task-progress` | Progress bar (in-progress) |
| `--task-star` | `#f59e0b` | `#fbbf24` | `text-task-star` | Star indicator |
| `--task-repeat` | `#3b82f6` | `#60a5fa` | `text-task-repeat` | Repeat icon |
| `--task-token-date` | `#f59e0b` | `#fbbf24` | `text-task-token-date` | Date token in NLP |
| `--task-token-project` | `#60a5fa` | `#93c5fd` | `text-task-token-project` | Project token in NLP |
| `--task-checkbox-done` | `#7b9e87` | `#7b9e87` | `bg-task-checkbox-done` | Checked checkbox fill (sage) |

**Used in**: `task-row.tsx` (row styling, title strikethrough), `task-badges.tsx` (priority/due/progress badges), `kanban-card.tsx` (overdue pill, progress bar).

---

## Sidebar

| Token | Warm | White | Dark | Tailwind |
|-------|------|-------|------|----------|
| `--sidebar` | `#efefe9` | `#f9f8f7` | `#202020` | `bg-sidebar` |
| `--sidebar-foreground` | `#8a857a` | `#5f5e59` | `#b5b3ae` | `text-sidebar-foreground` |
| `--sidebar-primary` | `#1a1917` | `#37352f` | `#e8e5df` | `text-sidebar-primary` |
| `--sidebar-primary-foreground` | `#edeae4` | `#ffffff` | `#202020` | `text-sidebar-primary-foreground` |
| `--sidebar-accent` | `rgba(0,0,0,0.05)` | `rgba(0,0,0,0.04)` | `#2a2a2a` | `bg-sidebar-accent` |
| `--sidebar-accent-foreground` | `var(--sidebar-foreground)` | `var(--sidebar-foreground)` | `var(--sidebar-primary)` | `text-sidebar-accent-foreground` |
| `--sidebar-border` | `#d9d5ce` | `#e9e9e7` | `#333333` | `border-sidebar-border` |
| `--sidebar-ring` | `var(--tint)` | `var(--tint)` | `var(--tint)` | `ring-sidebar-ring` |
| `--sidebar-muted` | `#b5b0a6` | `#b0afab` | `#6b6b6b` | `text-sidebar-muted` |
| `--sidebar-terracotta` | `var(--tint)` | `var(--tint)` | `var(--tint)` | `bg-sidebar-terracotta` |
| `--sidebar-text-folder` | `#3d3a35` | `#37352f` | `#c5c0b8` | `text-sidebar-text-folder` |
| `--sidebar-text-child` | `#5c5850` | `#6b6966` | `#9a958d` | `text-sidebar-text-child` |
| `--sidebar-dot-inactive` | `#d9d5ce` | `#e3e2e0` | `#444444` | `bg-sidebar-dot-inactive` |
| `--sidebar-surface` | `rgba(0,0,0,0.04)` | `rgba(0,0,0,0.03)` | `#2a2a2a` | `bg-sidebar-surface` |

---

## Graph View

| Token | Warm | White | Dark | Usage |
|-------|------|-------|------|-------|
| `--graph-node-note` | `#4a9e8e` | `#448c7c` | `#5abfad` | Note nodes |
| `--graph-node-journal` | `#8b5cf6` | `#7c3aed` | `#a78bfa` | Journal nodes |
| `--graph-node-task` | `#d4944a` | `#c87533` | `#e8a960` | Task nodes |
| `--graph-node-project` | `#5a8a5a` | `#4a7a4a` | `#6aaa6a` | Project nodes |
| `--graph-node-tag` | `#c2855a` | `#b07040` | `#d4a070` | Tag nodes |
| `--graph-edge-default` | `#8c8c8c` | `#9b9a97` | `#6b6966` | Default edges |
| `--graph-edge-wikilink` | `#8c8c8c` | `#9b9a97` | `#6b6966` | Wiki link edges |
| `--graph-edge-task-note` | `#c4a46a` | `#c4a46a` | `#b89a5a` | Task-note edges |
| `--graph-edge-project-task` | `#9a8abd` | `#9a8abd` | `#8a7aad` | Project-task edges |
| `--graph-edge-tag-cooccurrence` | `#a8a6a1` | `#c4c2bc` | `#5a5855` | Tag co-occurrence edges |
| `--graph-ghost-node` | `#c4c2bc` | `#d4d2cc` | `#3a3840` | Orphan/ghost nodes |
| `--graph-dimmed-node` | `#e4e4de` | `#e3e2e0` | `#2a2830` | Dimmed (unfocused) nodes |
| `--graph-edge-soft` | `#a8a6a0` | `#bfbdb6` | `#6b6966` | Soft background edges |
| `--graph-bg` | `#f6f5f0` | `#ffffff` | `#0e0e10` | Graph canvas bg |
| `--graph-label-color` | `#1a1a1a` | `#37352f` | `#bcbab6` | Node label text |

---

## Queue List

| Token | Warm | White | Dark | Tailwind |
|-------|------|-------|------|----------|
| `--queue-bg` | `#eae8e1` | `#f7f6f3` | `#161618` | `bg-queue-bg` |
| `--queue-number-bg` | `#d4d1c5` | `#e3e2e0` | `#2a2a2e` | `bg-queue-number-bg` |

---

## Inbox-Specific Patterns

### Type Icon Colors

Defined as Tailwind classes in `inbox-list.tsx`, not CSS variables:

| Type | Light | Dark |
|------|-------|------|
| link | `text-indigo-500` | `text-indigo-400` |
| voice | `text-amber-500` | `text-amber-400` |
| image | `text-emerald-500` | `text-emerald-400` |
| clip | `text-purple-400` | `text-purple-300` |
| note | `text-muted-foreground/60` | (same) |
| pdf | `text-red-500` | `text-red-400` |
| social | `text-sky-400` | `text-sky-300` |
| video | `text-sky-500` | `text-sky-400` |
| reminder | `text-amber-500` | `text-amber-400` |

### Selection States

Selected items use `var(--user-accent-color)` with layered opacity:

| State | Background | Ring |
|-------|-----------|------|
| Selected | `bg-[var(--user-accent-color)]/[0.04]` | `ring-[var(--user-accent-color)]/25` |
| Selected hover | `bg-[var(--user-accent-color)]/[0.06]` | (same) |
| Focused (not selected) | `bg-muted` | `ring-[var(--user-accent-color)]/40` |
| Stale item | `opacity-60` | — |

### Hardcoded Values

| Value | File | Suggested Token |
|-------|------|-----------------|
| `#E8A44A` | `inbox-health-view.tsx` (heatmap cell) | `--heatmap-fill` |
| `#50505A` | `inbox-health-view.tsx` (heatmap label) | `--heatmap-label` |

---

## Typography

### Font Stacks

| Token | Stack | Tailwind | Usage |
|-------|-------|----------|-------|
| `--font-sans` | `ui-sans-serif, -apple-system, system-ui, Segoe UI Variable Display, ...` | `font-sans` | UI labels, metadata, body |
| `--font-serif` | `Crimson Pro Variable, Georgia, Times New Roman, serif` | `font-serif` | Card titles, editorial content |
| `--font-display` | `Playfair Display Variable, Crimson Pro Variable, Georgia, serif` | `font-display` | Dramatic headers, empty states |
| `--font-heading` | `Space Grotesk Variable, system-ui, sans-serif` | `font-heading` | Section headings, onboarding |
| `--font-mono` | `JetBrains Mono Variable, SF Mono, Fira Code, monospace` | `font-mono` | Code blocks, technical text |

### Common Size Scale

Not tokenized — used as Tailwind/inline values:

| Size | Tailwind | Usage |
|------|----------|-------|
| 9px | `text-[9px]` | Tiny badges (snooze count, filter count) |
| 11px | `text-[11px]` | Metadata (section counts, stat labels, due badges) |
| 12px | `text-xs` | Section headers, meta text, toolbar text |
| 13px | `text-[13px]` | Item titles (compact density), search input |
| 14px | `text-sm` | Item titles (comfortable density), body text |
| 18px | `text-lg` / `.card-title` | Card titles (serif) |
| 28px | `text-[28px]` | Stat card values (health view) |

### Heading Defaults

```css
h1–h6 { font-weight: 600; line-height: 1.2; letter-spacing: -0.01em; }
```

### Utility Classes

| Class | Definition | Usage |
|-------|-----------|-------|
| `.card-title` | `font-serif, 18px, line-height 1.2, text-primary` | Card title typography |
| `.text-meta` | `12px, text-tertiary, line-height 1.5` | Meta/caption text |
| `.text-tag` | `10px, weight 500, uppercase, tracking 0.05em` | Tag/badge labels |

---

## Border Radius

| Token | Value | Tailwind | Usage |
|-------|-------|----------|-------|
| `--radius` | `0.5rem` (8px) | — | Default radius |
| `--radius-sm` | `0.375rem` (6px) | `rounded-sm` | Small elements, heatmap cells |
| `--radius-md` | `0.5rem` (8px) | `rounded-md` | List rows, buttons |
| `--radius-lg` | `0.75rem` (12px) | `rounded-lg` | Cards, comfortable-density items |
| `--radius-xl` | `1rem` (16px) | `rounded-xl` | Large cards, panels |
| `--radius-2xl` | `1.25rem` (20px) | `rounded-2xl` | Modals, dialogs |
| `--radius-full` | `9999px` | `rounded-full` | Tags, badges, pills, avatars |

---

## Shadows

Flat-first design. Light modes use subtle shadows; dark mode uses heavier values for depth.

| Token | Warm | White | Dark |
|-------|------|-------|------|
| `--shadow-card` | `0 1px 2px rgb(0 0 0/0.03), 0 1px 3px rgb(0 0 0/0.05)` | `... /0.04), ... /0.06)` | `... /0.3), ... /0.4)` |
| `--shadow-card-hover` | `0 4px 6px -1px rgb(0 0 0/0.07), 0 2px 4px -2px rgb(0 0 0/0.05)` | `... /0.08), ... /0.04)` | `... /0.4), ... /0.3)` |
| `--shadow-dropdown` | `0 4px 24px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)` | `... 0.1), ... 0.06)` | `... 0.3), ... 0.2)` |

Tailwind: `shadow-card`, `shadow-card-hover`, `shadow-dropdown`.

---

## Layout & Spacing

8pt grid system. Most spacing uses Tailwind's built-in scale (multiples of 4px).

| Token | Value | Usage |
|-------|-------|-------|
| `--sidebar-width` | `240px` | Sidebar width (all themes) |
| `--card-width` | `280px` | Inbox/knowledge card width |
| `--card-height` | `200px` | Card height |

Tailwind mapping: `--spacing-sidebar: var(--sidebar-width)` enables `w-sidebar`.

---

## Animation

### Duration Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--duration-instant` | `100ms` | Hover states, micro-feedback, dropdown highlight |
| `--duration-fast` | `150ms` | Checkbox/selection transitions, quick-actions reveal |
| `--duration-normal` | `200ms` | Most interactions, item-remove, tag pop, fade-in-up |
| `--duration-slow` | `300ms` | Panel slides, chevron rotation |
| `--duration-deliberate` | `400ms` | Empty state entrance, significant view changes |

### Easing Curves

| Token | Value | Usage |
|-------|-------|-------|
| `--ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | Elements entering, most animations |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Elements leaving (item-remove, tag-exit) |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | Elements moving/transforming |

### Animation Utility Classes

| Class | Keyframe | Duration | Easing | Usage |
|-------|----------|----------|--------|-------|
| `.transition-card` | — | `--duration-fast` | `--ease-out` | Card transform + shadow |
| `.hover-lift:hover` | — | — | — | `translateY(-2px)` on hover |
| `.press-effect:active` | — | — | — | `scale(0.98)` on press |
| `.quick-actions-reveal` | — | `--duration-instant` | `--ease-out` | Slide-in action buttons |
| `.item-removing` | `item-remove` | `--duration-normal` | `--ease-in` | List item exit (compress + fade) |
| `.card-removing` | `card-remove` | `--duration-normal` | `--ease-in` | Card exit (shrink + fade) |
| `.tag-enter` | `tag-pop-in` | `--duration-normal` | `--ease-out` | Tag pill entrance |
| `.tag-exit` | `tag-pop-out` | `--duration-fast` | `--ease-in` | Tag pill exit |
| `.slide-up-enter` | `slide-up` | `--duration-normal` | `--ease-out` | Bulk action bar entrance |
| `.fade-in-up` | `fade-in-up` | `--duration-normal` | `--ease-out` | Staggered entrance |
| `.count-pulse` | `count-pulse` | `--duration-fast` | `--ease-out` | Badge count update |
| `.animate-drop-flash` | `drop-flash` | `1s` | `--ease-out` | Kanban card drop highlight |
| `.animate-row-drop-flash` | `row-drop-flash` | `300ms` | `--ease-out` | List row drop highlight |
| `.animate-fade-out` | `fade-out-badge` | `2s` | `ease-in` | Priority badge fade after drop |
| `.overdue-pulse` | `overdue-pulse` | `0.6s` | `--ease-out` | Overdue row mount flash |

### Stagger Classes

```css
.stagger-1 { animation-delay: 0ms; }
.stagger-2 { animation-delay: 100ms; }
.stagger-3 { animation-delay: 200ms; }
.stagger-4 { animation-delay: 300ms; }
```

Combine with `.fade-in-up` for sequential card/stat entrance.

### Reduced Motion

```css
@media (prefers-reduced-motion: reduce) { /* all durations → 0.01ms */ }
```

Removal animations (`.item-removing`, `.card-removing`) snap to `opacity: 0` instead. Stagger entrance (`.fade-in-up`) and quick-actions show immediately.

---

## Density System

Managed by `useDisplayDensity()` hook. Persisted to `localStorage` key `memry-display-density`.

| Property | Comfortable (default) | Compact |
|----------|-----------------------|---------|
| `pagePadding` | `px-6 lg:px-8 py-8 lg:py-12` | `px-4 lg:px-6 py-4 lg:py-6` |
| `headerMargin` | `mb-8 lg:mb-10` | `mb-4 lg:mb-5` |
| `sectionSpacing` | `space-y-6` | `space-y-4` |
| `watermarkSize` | `text-[8rem] lg:text-[10rem]` | `text-[5rem] lg:text-[6rem]` |
| `watermarkOffset` | `-left-2 lg:-left-4 -top-4 lg:-top-6` | `-left-1 lg:-left-2 -top-2 lg:-top-3` |
| `captureMargin` | `mb-6` | `mb-4` |
| `capturePadding` | `px-4 py-3` | `px-3 py-2` |
| `captureGap` | `gap-3` | `gap-2` |
| `captureRadius` | `rounded-xl` (16px) | `rounded-md` (8px) |
| `itemPadding` | `px-3 py-2.5` | `px-2 py-1.5` |
| `itemGap` | `gap-3` | `gap-2` |
| `itemRadius` | `rounded-md` (8px) | `rounded-md` (8px) |
| `iconSize` | `w-9 h-9` (36px) | `w-7 h-7` (28px) |
| `iconInnerSize` | `w-4 h-4` (16px) | `w-3.5 h-3.5` (14px) |
| `checkboxSize` | *(default)* | `h-3.5 w-3.5` (14px) |
| `sectionHeaderMargin` | `mb-2.5` | `mb-1.5` |
| `sectionTitleSize` | `text-xs` (12px) | `text-[11px]` |
| `titleSize` | `text-sm` (14px) | `text-[13px]` |
| `metaSize` | `text-xs` (12px) | `text-[11px]` |
| `rowHeight` | `48px` | `36px` |

Usage:
```tsx
const { density } = useDisplayDensity()
const config = DENSITY_CONFIG[density]
// <div className={config.itemPadding}>
```

---

## Scrollbar

| Class | Behavior |
|-------|----------|
| `.scrollbar-thin` | 8px track, rounded thumb, transparent track, dark-mode aware |
| `.scrollbar-none` | Hidden scrollbar (still functional) |

Light: `rgba(0,0,0,0.25)` thumb, hover `0.4`, active `0.5`.
Dark: `rgba(255,255,255,0.25)` thumb, hover `0.4`, active `0.5`.

---

## Checklist: Applying Tokens to New Pages

1. Use `bg-background` / `text-foreground` as base
2. Use `bg-surface` for secondary panels; `bg-surface-active` for hover
3. Typography: `text-text-primary` for titles, `text-secondary` for body, `text-tertiary` for meta
4. Interactive elements: `bg-primary` buttons, `bg-tint` for user-themed accents
5. Borders: `border-border` default; use `/50` opacity for subtle dividers
6. Shadows: `shadow-card` for cards, `shadow-dropdown` for popovers
7. Radius: `rounded-md` for rows, `rounded-lg` for cards, `rounded-full` for pills
8. Animation: pick duration from the 5-level scale; always use `--ease-out` for entrances
9. Density: consume `DENSITY_CONFIG[density]` for all spacing/sizing if the page supports it
10. Test all 3 themes + `prefers-reduced-motion`
