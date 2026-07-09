# Desktop Design Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved design spec (`docs/superpowers/specs/2026-07-09-desktop-design-tokens-design.md`) to the desktop renderer: neutral dark palette, fixed 12–24px type scale for chrome, SF Pro everywhere with weights capped at medium, hugeicons at 1px stroke, zero remaining lucide imports.

**Architecture:** All changes land in the existing token layer — `apps/desktop/src/renderer/src/assets/base.css` (CSS custom properties + Tailwind v4 `@theme` blocks) and `apps/desktop/src/renderer/src/lib/icons/` (central icon factory). No component sweep. The only per-file edits are 9 one-line lucide import swaps.

**Tech Stack:** Tailwind CSS v4 (`@theme inline` in CSS, no JS config), `@hugeicons/react`, Vitest (`--project renderer`), Electron 39 + React 19.

## Global Constraints

- Prettier: single quotes, no semicolons, 100 char width, no trailing commas.
- Scope: `apps/desktop` renderer only. No settings-schema, IPC, DB, or sync changes.
- Dark theme (`.dark`) colors only; `:root` (paper) and `.white` theme colors untouched.
- Accent, task, graph, card-pastel, shadow tokens in `.dark` untouched.
- The user font-size setting (`use-theme-sync.ts`, root 14/16/20px) must keep scaling editor content; chrome must NOT scale (hence px, not rem, for the type scale).
- Explicit `strokeWidth={...}` props at call sites are intentional; do not remove them.
- Commit messages: conventional style, no Co-Authored-By line.
- All hexes lowercase in CSS (match file style).

---

### Task 1: Neutral dark palette in `.dark`

**Files:**

- Modify: `apps/desktop/src/renderer/src/assets/base.css:1197-1241` (`.dark` block: BASE COLORS, TYPOGRAPHY COLORS, UI SEMANTIC COLORS sections)

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: new `.dark` values for `--background`, `--foreground`, `--surface`, `--surface-active`, `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-bright`, `--muted`, `--muted-foreground`, `--popover`, `--popover-foreground`, `--border`, `--input`, `--card`, `--card-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--accent`, `--accent-foreground`, `--ring`. No consumer code changes — vars flow through the existing `@theme inline` mappings.

- [ ] **Step 1: Replace the `.dark` base colors**

In `base.css`, inside the `.dark {` block (starts ~line 1186), replace:

```css
/* ===== BASE COLORS - Dark Mode (Neutral Charcoal) ===== */
--background: #181919;
--foreground: #bcbab6;
--surface: #222222;
--surface-active: #2a2a2a;
```

with:

```css
/* ===== BASE COLORS - Dark Mode (Neutral Charcoal) ===== */
--background: #1a1a1a;
--foreground: #a6a6a6;
--surface: #1f1f1f;
--surface-active: #242424;
```

Leave `--critic-review-card-hover-background` and `--critic-review-actions-background` as they are.

- [ ] **Step 2: Replace the `.dark` typography colors**

Replace:

```css
/* ===== TYPOGRAPHY COLORS - Dark Mode ===== */
--text-primary: #bcbab6;
--text-secondary: #bcbab6;
--text-tertiary: #ada9a3;
--text-bright: #dadada;
```

with:

```css
/* ===== TYPOGRAPHY COLORS - Dark Mode ===== */
--text-primary: #e0e0e0;
--text-secondary: #a6a6a6;
--text-tertiary: #7f7f7f;
--text-bright: #e0e0e0;
```

- [ ] **Step 3: Replace the `.dark` UI semantic colors**

Replace:

```css
/* ===== UI SEMANTIC COLORS - Dark Mode ===== */
--muted: #222222;
--muted-foreground: #ada9a3;
--popover: #1e1e1e;
--popover-foreground: #bcbab6;
--border: #2a2a2a;
--input: #333333;
--card: #222222;
--card-foreground: #bcbab6;
--primary: #e8e6e1;
--primary-foreground: #191919;
--secondary: #222222;
--secondary-foreground: #bcbab6;
--accent: #2a2a2a;
--accent-foreground: #bcbab6;
--destructive: #dc2626;
--destructive-foreground: #fafafa;
--ring: #6b6b6b;
```

with:

```css
/* ===== UI SEMANTIC COLORS - Dark Mode ===== */
--muted: #1f1f1f;
--muted-foreground: #7f7f7f;
--popover: #1f1f1f;
--popover-foreground: #a6a6a6;
--border: #222222;
--input: #242424;
--card: #1f1f1f;
--card-foreground: #a6a6a6;
--primary: #e0e0e0;
--primary-foreground: #1a1a1a;
--secondary: #1f1f1f;
--secondary-foreground: #a6a6a6;
--accent: #242424;
--accent-foreground: #a6a6a6;
--destructive: #dc2626;
--destructive-foreground: #fafafa;
--ring: #7f7f7f;
```

(`--destructive`/`--destructive-foreground` are unchanged but sit inside the replaced range — keep values identical.)

- [ ] **Step 4: Verify no old neutrals remain in `.dark`**

Run: `rtk grep -n "bcbab6\|ada9a3" apps/desktop/src/renderer/src/assets/base.css`
Expected: matches ONLY in graph tokens (`--graph-label-color: #bcbab6`) and any non-`.dark`-neutral context. No matches for the replaced tokens above.

Run: `pnpm lint`
Expected: PASS (CSS untouched by ESLint, catches nothing new).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/assets/base.css
git commit -m "feat(desktop): neutral dark theme palette per design spec"
```

---

### Task 2: Fixed px type scale for chrome

**Files:**

- Modify: `apps/desktop/src/renderer/src/assets/base.css:2027-2032` (`@theme inline` block, after the FONT FAMILIES section)

**Interfaces:**

- Consumes: nothing.
- Produces: Tailwind utilities `text-xs`…`text-4xl` now emit fixed px sizes app-wide. Later tasks assume `text-sm` = 13px is the de-facto UI base.

- [ ] **Step 1: Add font-size tokens to `@theme inline`**

In `base.css`, inside `@theme inline {` (line 2027), directly after:

```css
/* ===== FONT FAMILIES ===== */
--font-sans: var(--font-sans);
--font-serif: var(--font-serif);
--font-heading: var(--font-heading);
```

insert:

```css
/* ===== TYPE SCALE (chrome) =====
     Fixed px on purpose: the user font-size setting scales the root rem,
     which must keep affecting editor content only — never app chrome. */
--text-xs: 12px;
--text-xs--line-height: 16px;
--text-sm: 13px;
--text-sm--line-height: 18px;
--text-base: 14px;
--text-base--line-height: 20px;
--text-lg: 16px;
--text-lg--line-height: 22px;
--text-xl: 18px;
--text-xl--line-height: 24px;
--text-2xl: 24px;
--text-2xl--line-height: 30px;
--text-3xl: 24px;
--text-3xl--line-height: 30px;
--text-4xl: 24px;
--text-4xl--line-height: 30px;
```

(3xl/4xl clamp to 24px — the spec's largest size. Only `journal-date-display.tsx`, `inbox-stats-cards.tsx`, `templates.tsx` use them; no 5xl+ exists in the renderer.)

- [ ] **Step 2: Verify clamp coverage is complete**

Run: `rtk grep -rn "text-5xl\|text-6xl\|text-7xl" apps/desktop/src/renderer/src --include="*.tsx"`
Expected: no matches — every size utility in the renderer is covered by the xs–4xl tokens above.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/assets/base.css
git commit -m "feat(desktop): fixed 12-24px chrome type scale, editor keeps rem scaling"
```

---

### Task 3: SF Pro everywhere, weights capped at medium

**Files:**

- Modify: `apps/desktop/src/renderer/src/assets/base.css:903-905` (`:root` font families)
- Modify: `apps/desktop/src/renderer/src/assets/base.css:1192-1194` (`.dark` font families)
- Modify: `apps/desktop/src/renderer/src/assets/base.css` `@theme inline` block (weights)
- Modify: `apps/desktop/src/renderer/src/assets/base.css` near the existing `.dark .bn-editor` rules (~line 83) for the editor bold pin

**Interfaces:**

- Consumes: nothing.
- Produces: `--font-heading`/`--font-display` resolve to the SF Pro system stack; `font-semibold`/`font-bold` utilities render at 500; `.bn-editor strong/b` stay 700.

- [ ] **Step 1: Point heading/display at the sans stack — `:root`**

In the `:root` block (~line 903), replace:

```css
--font-serif: 'Crimson Pro Variable', Georgia, 'Times New Roman', serif;
--font-display: 'Playfair Display Variable', 'Crimson Pro Variable', Georgia, serif;
--font-heading: 'Space Grotesk Variable', system-ui, sans-serif;
```

with:

```css
--font-serif: 'Crimson Pro Variable', Georgia, 'Times New Roman', serif;
--font-display: var(--font-sans);
--font-heading: var(--font-sans);
```

- [ ] **Step 2: Same replacement in `.dark`**

In the `.dark` block (~line 1192), apply the identical replacement (the three lines are repeated there verbatim).

- [ ] **Step 3: Cap semibold/bold utilities at 500**

In `@theme inline`, directly after the TYPE SCALE section added in Task 2, insert:

```css
/* ===== WEIGHTS ===== SF Pro regular/medium only; bold utilities cap at medium. */
--font-weight-semibold: 500;
--font-weight-bold: 500;
```

- [ ] **Step 4: Pin editor content bold to 700**

Near the top-of-file editor rules (after the `.dark .bn-editor, .dark .bn-container` rule ~line 83), add:

```css
/* Weights are capped at 500 for chrome; user bold inside notes must stay bold. */
.bn-editor strong,
.bn-editor b {
  font-weight: 700;
}
```

- [ ] **Step 5: Verify**

Run: `rtk grep -n "Space Grotesk\|Playfair" apps/desktop/src/renderer/src/assets/base.css`
Expected: no matches inside `:root`/`.dark` font tokens (matches may remain in unrelated comments or font-face imports — if `@fontsource` imports for Space Grotesk/Playfair exist in renderer entry files, leave them; dead-import cleanup only if they are imported solely for these tokens).

Run: `rtk grep -rn "Space Grotesk\|Playfair\|fontsource.*space\|fontsource.*playfair" apps/desktop/src/renderer/src --include="*.ts" --include="*.tsx" -i`
Expected: if imports exist only for the removed tokens, delete those import lines too (your change made them unused).

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A apps/desktop/src/renderer/src
git commit -m "feat(desktop): SF Pro for headings/display, cap bold utilities at 500"
```

---

### Task 4: `createIcon` defaults to 1px stroke (TDD)

**Files:**

- Test: `apps/desktop/src/renderer/src/lib/icons/create-icon.test.tsx` (new)
- Modify: `apps/desktop/src/renderer/src/lib/icons/create-icon.tsx:14`

**Interfaces:**

- Consumes: `createIcon(icon: IconSvgElement): AppIcon` (existing).
- Produces: every `AppIcon` rendered without an explicit `strokeWidth` prop gets `stroke-width="1"` on its root `<svg>`; explicit props still win. `HugeiconsIcon` puts `strokeWidth` on the svg root when defined (verified in `@hugeicons/react` dist).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/lib/icons/create-icon.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Tick01Icon } from '@hugeicons/core-free-icons'
import { createIcon } from './create-icon'

describe('createIcon', () => {
  it('defaults stroke width to 1', () => {
    const Icon = createIcon(Tick01Icon)
    const { container } = render(<Icon />)
    expect(container.querySelector('svg')?.getAttribute('stroke-width')).toBe('1')
  })

  it('explicit strokeWidth overrides the default', () => {
    const Icon = createIcon(Tick01Icon)
    const { container } = render(<Icon strokeWidth={2} />)
    expect(container.querySelector('svg')?.getAttribute('stroke-width')).toBe('2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run --config config/vitest.config.ts --project renderer src/renderer/src/lib/icons/create-icon.test.tsx`
Expected: FAIL — first test gets `null` (no stroke-width when prop is undefined; hugeicons only sets it when defined).

- [ ] **Step 3: Implement the default**

In `create-icon.tsx`, change line 14 from:

```tsx
  >(({ className, strokeWidth, size, ...rest }, ref) => (
```

to:

```tsx
  >(({ className, strokeWidth = 1, size, ...rest }, ref) => (
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run --config config/vitest.config.ts --project renderer src/renderer/src/lib/icons/create-icon.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Run neighboring icon tests for regressions**

Run: `cd apps/desktop && pnpm exec vitest run --config config/vitest.config.ts --project renderer src/renderer/src/components/icon-picker.test.tsx src/renderer/src/components/more-zero-renderer-surfaces.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/icons
git commit -m "feat(desktop): default hugeicons stroke width to 1"
```

---

### Task 5: Migrate the 9 remaining lucide imports, drop the dependency

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/ui/command.tsx:4`
- Modify: `apps/desktop/src/renderer/src/components/ui/dialog.tsx:3`
- Modify: `apps/desktop/src/renderer/src/components/ui/spinner.tsx:1`
- Modify: `apps/desktop/src/renderer/src/components/ui/dropdown-menu.tsx:5`
- Modify: `apps/desktop/src/renderer/src/components/ui/select.tsx:3`
- Modify: `apps/desktop/src/renderer/src/components/calendar/marquee-selection-overlay.tsx:1`
- Modify: `apps/desktop/src/renderer/src/components/ai-elements/sources.tsx:4`
- Modify: `apps/desktop/src/renderer/src/agent-chat/sidebar-tabs.tsx:2`
- Modify: `apps/desktop/src/renderer/src/pages/settings/import-section.tsx:2`
- Modify: `apps/desktop/package.json` (remove `lucide-react`)

**Interfaces:**

- Consumes: existing `@/lib/icons` exports (all verified present in `icon-map.ts`): `Search` (L451), `X` (L467), `Loader2` (L474), `Check` (L462), `ChevronRight` (L395), `Circle` (L495), `ChevronDown` (L393), `ChevronUp` (L392), `Clock` (L339), `Book` (L322), `History` (L551). All are `AppIcon`s accepting `className`, `size`, `strokeWidth`.
- Produces: zero `lucide-react` imports in the repo; dependency removed.

- [ ] **Step 1: Swap the import lines (only the import line changes in each file)**

| File                                     | Old                                                            | New                                                                              |
| ---------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `ui/command.tsx`                         | `import { Search } from 'lucide-react'`                        | `import { Search } from '@/lib/icons'`                                           |
| `ui/dialog.tsx`                          | `import { X } from 'lucide-react'`                             | `import { X } from '@/lib/icons'`                                                |
| `ui/spinner.tsx`                         | `import { Loader2Icon } from 'lucide-react'`                   | `import { Loader2 as Loader2Icon } from '@/lib/icons'`                           |
| `ui/dropdown-menu.tsx`                   | `import { Check, ChevronRight, Circle } from 'lucide-react'`   | `import { Check, ChevronRight, Circle } from '@/lib/icons'`                      |
| `ui/select.tsx`                          | `import { Check, ChevronDown, ChevronUp } from 'lucide-react'` | `import { Check, ChevronDown, ChevronUp } from '@/lib/icons'`                    |
| `calendar/marquee-selection-overlay.tsx` | `import { Clock } from 'lucide-react'`                         | `import { Clock } from '@/lib/icons'`                                            |
| `ai-elements/sources.tsx`                | `import { BookIcon, ChevronDownIcon } from 'lucide-react'`     | `import { Book as BookIcon, ChevronDown as ChevronDownIcon } from '@/lib/icons'` |
| `agent-chat/sidebar-tabs.tsx`            | `import { History } from 'lucide-react'`                       | `import { History } from '@/lib/icons'`                                          |
| `pages/settings/import-section.tsx`      | `import { ChevronDown } from 'lucide-react'`                   | `import { ChevronDown } from '@/lib/icons'`                                      |

- [ ] **Step 2: Verify zero lucide imports and typecheck**

Run: `rtk grep -rn "lucide-react" apps/desktop/src`
Expected: no matches.

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS. If an `AppIcon` prop mismatch surfaces (e.g. a lucide-only prop), fix the call site to `className`/`size` equivalents.

- [ ] **Step 3: Remove the dependency**

In `apps/desktop/package.json`, delete the `"lucide-react": "..."` line from `dependencies`. Then:

Run: `pnpm install`
Expected: lockfile updated, install succeeds.

- [ ] **Step 4: Run renderer test suite**

Run: `pnpm --filter @memry/desktop test:renderer`
Expected: PASS (known flake: full-run SIGSEGV is a documented parallel flake — rerun the failed file solo before treating as real).

- [ ] **Step 5: Commit**

```bash
git add -A apps/desktop pnpm-lock.yaml
git commit -m "refactor(desktop): finish lucide-react to hugeicons migration"
```

---

### Task 6: Full verification + docs gate

**Files:**

- Possibly modify: `apps/docs/src/**` (only if `docs:impact` flags missing docs)

**Interfaces:**

- Consumes: all prior tasks' changes.
- Produces: green gates; branch ready for PR.

- [ ] **Step 1: Static gates**

Run: `pnpm lint && pnpm --filter @memry/desktop typecheck:web`
Expected: PASS

- [ ] **Step 2: Renderer + main test suites**

Run: `pnpm test:desktop`
Expected: PASS (SIGSEGV flake rule from Task 5 applies; pre-existing type errors in `websocket.test.ts`/`folders.test.ts` are known and ignorable).

- [ ] **Step 3: Live visual sweep (dev app)**

Run: `pnpm dev` and verify in the running app:

- Dark theme: sidebar/list/menu/dialog contrast — strong text `#e0e0e0`, default `#a6a6a6`, subtle `#7f7f7f`, selected rows `#242424`, borders `#222222` (subtle but visible), no unreadable text anywhere (tasks page, calendar, settings, agent chat).
- Chrome text: base UI reads at 13px (`text-sm`); page titles ≤ 24px; journal date header no longer Playfair.
- Settings → font size small/medium/large: editor content scales, chrome does not move.
- A note with bold text: bold still renders heavy (700) in the editor.
- Icons: sidebar/toolbar icons render with 1px stroke; tiny checkmarks (explicit overrides) unchanged.
- Light (paper) and white themes: colors unchanged from before; only fonts/sizes/icons differ.

Expected: all checks pass; screenshot anything questionable for Kaan.

- [ ] **Step 4: React hygiene scan**

Run: `npx -y react-doctor@latest .`
Expected: no new diagnostics attributable to this diff.

- [ ] **Step 5: Docs gate**

Run: `pnpm docs:impact --base origin/main --strict`
If `missing-docs`: run `pnpm docs:ai-update --base origin/main`, review the generated docs edits, then re-run `pnpm docs:impact --base origin/main --strict` and `pnpm docs:build`.
Expected: strict gate green.

- [ ] **Step 6: Final commit (if docs changed)**

```bash
git add apps/docs
git commit -m "docs: describe desktop design token changes"
```
