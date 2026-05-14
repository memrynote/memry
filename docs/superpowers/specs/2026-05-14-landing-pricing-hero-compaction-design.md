# Landing /pricing Hero Compaction — Design

**Date:** 2026-05-14
**Owner:** Kaan
**Scope:** `apps/landing/src/pages/Pricing.tsx` — `Hero` section only

## Problem

On `/pricing` today, the hero section consumes ~480px (md+) and ~540px (mobile)
of vertical space. The tier cards — the actual decision surface — sit below
the fold on a 13" laptop. Visitors must scroll before they encounter the
prices.

## Goal

Compact the hero so the first row of tier cards is visible above the fold
on a 13" laptop (1280×800) and comfortably above the fold on 15"+ displays,
without touching any other section of the page.

## Non-Goals

- No changes to `TierGrid`, `TierCard`, `PriceBlock`, `LimitsGrid`
- No changes to `BelieverNarrative`, `LifecycleTimeline`, `LimitMatrix`,
  `PricingFaq`, `FinalCta`
- No changes to `CadenceToggle` component
- No changes to tier data (`SYNC_PLAN_TIERS`) or any landing constants
- No section reordering or copy rewrites outside the hero

## Design Decisions

### 1. Hero content

Keep three elements: headline, paragraph, cadence toggle.
Remove two: kicker (`Pricing · V.1`) and the sub-line under the toggle
(`Switch any time. No tier change fees.`).

### 2. Layout

Centered classic — same alignment pattern as `Hero` on `/` and other
landing pages. No editorial split, no sticky control bar.

### 3. Density target

Moderate compaction. Hero height drops to ≈220px (md+) and ≈340px (mobile).

### 4. Type & spacing tokens (the diff)

Inside `Hero({ cadence, setCadence })`:

| element                        | before                                   | after                                  |
| ------------------------------ | ---------------------------------------- | -------------------------------------- |
| `<section>` padding            | `pt-32 pb-16 sm:pt-40 sm:pb-20`          | `pt-20 pb-8 sm:pt-24 sm:pb-10`         |
| Kicker `<p>` (`PRICING · V.1`) | present                                  | removed                                |
| `<h1>` font size               | `text-5xl … md:text-7xl`                 | `text-4xl … md:text-5xl`               |
| `<h1>` top margin              | `mt-5`                                   | `mt-0` (now first child)               |
| Paragraph                      | `mt-7 max-w-xl text-lg … md:text-xl`     | `mt-5 max-w-lg text-base … md:text-lg` |
| Paragraph copy                 | (unchanged)                              | (unchanged)                            |
| Toggle wrapper                 | `mt-10 flex flex-col items-center gap-3` | `mt-7 flex justify-center`             |
| Sub-line under toggle          | present                                  | removed                                |

All other classes and JSX (the wrapping `motion.div`, `Container size="md"`,
the `CadenceToggle` invocation) are unchanged.

### 5. Background gradient

The radial gradient backdrop element shrinks to maintain a soft warm bleed
into the tier grid section (avoids abrupt clipping at the hero edge):

```jsx
// before
className = '... -z-10 h-[420px] bg-[radial-gradient(...)]'
// after
className = '... -z-10 h-[360px] bg-[radial-gradient(...)]'
```

The gradient extends ~140px past the new hero into the first tier card row.

### 6. Animations

Unchanged. The `motion.div` entrance on the hero composition still runs at
mount. Tier cards continue to use `whileInView` with staggered
`delay: index * 0.08`; because they are now in viewport on initial load on
13"+ screens, framer-motion fires the stagger immediately and the page reads
as animated rather than static. No code change required.

## Responsive

|                   | mobile (default)     | sm (640px+)         | md (768px+)   |
| ----------------- | -------------------- | ------------------- | ------------- |
| section padding   | `pt-20 pb-8`         | `sm:pt-24 sm:pb-10` | inherits sm   |
| `<h1>` size       | `text-4xl`           | inherits            | `md:text-5xl` |
| paragraph         | `text-base max-w-lg` | inherits            | `md:text-lg`  |
| gradient backdrop | `h-[360px]`          | inherits            | inherits      |

The hard `<br />` between "respects" and "your wallet." stays — it wraps
cleanly at all breakpoints with `text-4xl` minimum.

## Risks & Edge Cases

- **Hero feels clipped.** Mitigated by the soft gradient bleed (decision 5).
- **Tier card stagger feels rushed** because cards are in viewport at load.
  framer-motion's `whileInView` handles this gracefully — the stagger fires
  in sequence but the user reads it as "page came alive on arrival" rather
  than "cards animated in after scroll." Acceptable.
- **A11y / SEO.** The kicker provided no accessible info beyond decoration;
  `<h1>` remains the page's top heading and `PageHead page="pricing"` still
  controls `<title>` and meta. No regression.

## Verification

Manual checks Kaan runs before landing:

1. `pnpm dev:landing` → open `http://localhost:<port>/pricing`
2. **1280×800** (13" laptop): first row of tier cards fully above the fold.
3. **1920×1080** (15"+): full first card row + top of "Compare every limit"
   table visible.
4. **375×667** (mobile portrait): hero ≈ 340px tall, smooth scroll to cards;
   `<br />` wrap looks intentional.
5. `pnpm --filter @memry/landing lint` and
   `pnpm --filter @memry/landing typecheck` (or repo-wide `pnpm lint` /
   `pnpm typecheck`) stay green.
6. Visual sanity that gradient bleed reads as warm wash and not a banding
   artifact.

## Out of Scope (Explicit Deferrals)

- Reordering sections below the hero (deferred to a separate redesign pass
  if it ever happens).
- Inline/sticky cadence toggle behavior.
- Trimming or rewriting paragraph copy.
- Anything outside `Hero()` in `Pricing.tsx`.
