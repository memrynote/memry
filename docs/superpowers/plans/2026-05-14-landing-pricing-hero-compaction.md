# Landing `/pricing` Hero Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compact the `Hero` section of the landing `/pricing` page so the first row of tier cards is visible above the fold on a 13" laptop, without touching any other section of the page.

**Architecture:** Single-function edit inside `apps/landing/src/pages/Pricing.tsx`. The change is purely structural/Tailwind-class — no new components, no new state, no constant changes. Verification is lint + typecheck + manual visual checks at three viewport widths. There is no Vitest coverage of `Hero` today and visual class swaps are not meaningfully unit-testable, so this plan does not introduce a unit test.

**Tech Stack:** React 19, Tailwind CSS, Vite, `framer-motion` (untouched), `lucide-react` (untouched).

**Spec:** [docs/superpowers/specs/2026-05-14-landing-pricing-hero-compaction-design.md](../specs/2026-05-14-landing-pricing-hero-compaction-design.md)

---

## File Structure

- **Modify:** `apps/landing/src/pages/Pricing.tsx` — only the `Hero` function (currently lines ~92-129) and its sibling gradient `<div>` (currently lines ~95-98).
- **No other files touched.**

---

## Task 1: Compact the Hero section

**Files:**

- Modify: `apps/landing/src/pages/Pricing.tsx` (Hero function, lines ~92-129)

This task collapses every spec change into a single atomic commit because the gradient backdrop, the kicker removal, the type shrink, and the toggle wrapper change are one logical concern: "compact the hero." Splitting them creates intermediate states where the hero looks broken (e.g. shrunk type but oversized padding).

- [ ] **Step 1: Open the file and locate the `Hero` function**

Read `apps/landing/src/pages/Pricing.tsx` and locate the `Hero` function. It starts with `function Hero({ cadence, setCadence }: { ... })` near the top of the file (around line 92 in the current revision; use the function name as the anchor, line numbers may drift).

The function returns a `<section>` containing:

1. A gradient `<div>` (the backdrop)
2. A `<Container size="md">` wrapping a `motion.div` with `className="text-center"`
3. Inside the `motion.div`: a kicker `<p>`, an `<h1>`, a paragraph `<p>`, and a wrapper `<div>` containing `CadenceToggle` + a sub-line `<p>`

- [ ] **Step 2: Update the `<section>` opening tag — shrink padding**

Find:

```tsx
<section className="relative overflow-hidden pt-32 pb-16 sm:pt-40 sm:pb-20">
```

Replace with:

```tsx
<section className="relative overflow-hidden pt-20 pb-8 sm:pt-24 sm:pb-10">
```

- [ ] **Step 3: Shrink the gradient backdrop from `h-[420px]` to `h-[360px]`**

Find:

```tsx
<div
  aria-hidden
  className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] bg-[radial-gradient(ellipse_at_top,rgba(255,103,26,0.10),transparent_60%)]"
/>
```

Replace with:

```tsx
<div
  aria-hidden
  className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[360px] bg-[radial-gradient(ellipse_at_top,rgba(255,103,26,0.10),transparent_60%)]"
/>
```

The only change is `h-[420px]` → `h-[360px]`.

- [ ] **Step 4: Remove the kicker `<p>`**

Inside the `motion.div`, delete the entire kicker element:

```tsx
<p className="font-mono-accent text-[11px] uppercase tracking-[0.32em] text-terracotta">
  Pricing &nbsp;·&nbsp; V.1
</p>
```

This is the first child of `motion.div` (right after the opening `motion.div` tag, before the `<h1>`).

- [ ] **Step 5: Resize the `<h1>` and zero its top margin**

Find:

```tsx
<h1 className="mt-5 font-serif text-5xl font-normal leading-[1.05] text-ink text-balance md:text-7xl">
  Sync that respects
  <br />
  your <span className="italic text-terracotta">wallet.</span>
</h1>
```

Replace with:

```tsx
<h1 className="font-serif text-4xl font-normal leading-[1.05] text-ink text-balance md:text-5xl">
  Sync that respects
  <br />
  your <span className="italic text-terracotta">wallet.</span>
</h1>
```

Two changes: drop `mt-5` (since the `<h1>` is now the first child after kicker removal) and ramp from `text-5xl … md:text-7xl` down to `text-4xl … md:text-5xl`. Inner content and the `<br />` are unchanged.

- [ ] **Step 6: Resize the paragraph**

Find:

```tsx
<p className="mx-auto mt-7 max-w-xl text-lg leading-relaxed text-muted text-balance md:text-xl">
  The local app stays free, forever. Sync is paid — fair, predictable, and end-to-end encrypted
  before a single byte leaves your device.
</p>
```

Replace with:

```tsx
<p className="mx-auto mt-5 max-w-lg text-base leading-relaxed text-muted text-balance md:text-lg">
  The local app stays free, forever. Sync is paid — fair, predictable, and end-to-end encrypted
  before a single byte leaves your device.
</p>
```

Changes: `mt-7` → `mt-5`, `max-w-xl` → `max-w-lg`, `text-lg` → `text-base`, `md:text-xl` → `md:text-lg`. `mx-auto`, `leading-relaxed`, `text-muted`, `text-balance` are unchanged. Copy is unchanged.

- [ ] **Step 7: Simplify the toggle wrapper (drop the sub-line)**

Find:

```tsx
<div className="mt-10 flex flex-col items-center gap-3">
  <CadenceToggle cadence={cadence} setCadence={setCadence} />
  <p className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/70">
    Switch any time. No tier change fees.
  </p>
</div>
```

Replace with:

```tsx
<div className="mt-7 flex justify-center">
  <CadenceToggle cadence={cadence} setCadence={setCadence} />
</div>
```

Two changes:

1. The sub-line `<p>` is removed.
2. The wrapper goes from `mt-10 flex flex-col items-center gap-3` to `mt-7 flex justify-center` (the toggle is the only child now, so no need for `flex-col`/`gap`).

- [ ] **Step 8: Verify the Hero function compiles**

Run lint scoped to the landing app:

```bash
pnpm --filter @memry/landing lint
```

Expected: zero errors related to `Pricing.tsx`. If `react/no-unescaped-entities` or other rules trip, the change is wrong — re-inspect.

- [ ] **Step 9: Verify typecheck passes**

Run typecheck scoped to the landing app:

```bash
pnpm --filter @memry/landing typecheck
```

Expected: clean exit. The change only touches class strings and removes elements, so this should pass trivially. If anything fails, the failure is unrelated to this change (or a typo was introduced — re-inspect).

- [ ] **Step 10: Manual visual verification at three viewports**

Start the dev server:

```bash
pnpm dev:landing
```

Open the printed URL + `/pricing` in a browser. Resize the window to these viewports (use browser devtools' device toolbar):

1. **1280 × 800** (13" laptop): the first row of tier cards (Standard, Plus, Believer) should be fully visible above the fold. The hero band should measure ~220px tall.
2. **1920 × 1080** (15"+ desktop): full first tier-card row plus the top of "Compare every limit" matrix should be visible without scrolling.
3. **375 × 667** (iPhone SE / mobile portrait): the hero should be ~340px tall. The hard `<br />` between "respects" and "your wallet." should wrap cleanly (no awkward line breaks mid-word).

Also confirm visually:

- The radial gradient still bleeds gently into the area where the tier cards begin — there should be a warm wash behind the top of the first card row, no hard banding.
- The cadence toggle is horizontally centered.
- The `motion.div` entrance animation still fires on page load.

If any check fails, stop and inspect — do not commit.

- [ ] **Step 11: Stop the dev server, then commit**

```bash
git add apps/landing/src/pages/Pricing.tsx
git commit -m "feat(landing): compact pricing hero so tier cards land above the fold"
```

---

## Self-Review (Post-Plan)

**Spec coverage:**

- Design decision 1 (hero content — drop kicker + sub-line, keep headline/paragraph/toggle) → Steps 4 and 7.
- Design decision 2 (centered classic layout) → no markup change required; existing `text-center` on `motion.div` and `mx-auto` on paragraph already centered. ✓
- Design decision 3 (moderate density ~220px) → Steps 2, 5, 6, 7 (cumulative).
- Design decision 4 (type & spacing token diff) → Steps 2, 5, 6, 7.
- Design decision 5 (gradient `h-[420px]` → `h-[360px]`) → Step 3.
- Design decision 6 (animations unchanged) → not modified; `motion.div` and `whileInView` callsites untouched.
- Responsive table (mobile / sm / md) → Steps 2, 5, 6 cover all breakpoints.
- Verification checklist (lint, typecheck, three viewports, gradient bleed) → Steps 8-10.

**Placeholder scan:** No "TBD", "TODO", "implement later". Every code change is shown in full. No "similar to Task N" references (there is only one task).

**Type / signature consistency:** No types or function signatures changed. The only props passed to `CadenceToggle` (`cadence`, `setCadence`) are unchanged.

No gaps. Plan stands.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-landing-pricing-hero-compaction.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks. Overkill for a one-task plan but it's the convention.
2. **Inline Execution** — execute the task in this session using `superpowers:executing-plans`, single checkpoint after Step 10 before the commit.

Which approach?
