# Landing Design Consistency — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared `site/` design layer and prove it by converting Roadmap and Changelog — the site's two leanest, mutually-identical pages — to a single `PageHero` primitive.

**Architecture:** Promote `components/sections/home2/` to `components/site/` (it is the site's design language, not homepage-local). Add a central route→tint data map in `lib/` with real tests. Add one `PageHero` primitive that replaces all three of today's hero archetypes. Convert the two pilot pages.

**Tech Stack:** React 19, React Router, Tailwind v4 (`@theme` tokens in `src/index.css`), framer-motion, Vite + a `prerender.ts` SSG step, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-07-14-landing-site-design-consistency-design.md`

## Global Constraints

- **Branch:** `landing-craft-redesign`. Commit per task. Do not open a new branch or PR.
- **Scope:** landing only. Never touch `apps/desktop` or `apps/sync-server`.
- **RTL / logical properties:** all new or touched code uses logical Tailwind classes — `ms/me`, `ps/pe`, `start/end`, `text-start`/`text-end`, `border-s/e`, `rounded-s/e-*`. Never `ml/mr`, `pl/pr`, `left/right`, `text-left/right`, `border-l/r`, `rounded-l/r-*`. The pre-commit renderer guard rejects an **entire file** on any physical class, so a file you touch must be clean throughout.
- **No new design tokens.** Every tint already exists in `src/index.css`. If you think you need a new token, stop and ask.
- **No copy rewriting.** This is a re-skin. Headline and body strings carry over verbatim, including any that look wrong.
- **WCAG AA** on every tint. `text-ink` on the seven light tints; `text-ink-inverted` on `ink`.
- **Reduced motion:** `MotionConfig reducedMotion` is already applied site-wide in `App.tsx`. Gate hover transforms behind `motion-safe:`.
- **Test glob is `src/**/\*.test.ts`** — a test file must end in `.test.ts` to run. Imports use explicit extensions (`from './seo.ts'`).
- **There is no component/render test harness** (no jsdom, no testing-library). Do not add one. JSX is verified by `build` (which prerenders every route) plus a manual visual pass.
- **The site is light-only.** Commit `2724277f0` removed the dark theme: no `.dark` block, no `@custom-variant dark`, no `dark:` utility anywhere in `src/`. Do not add `dark:` variants and do not give any tint a second definition — `site-tints.test.ts` fails if you do.

## Deviation from the spec

The spec's Phase 1 lists `Faq` and `FinalCta` as foundation work. **They are deferred to Phase 2.** Roadmap is hero + three lists; Changelog is hero + one entry list. Neither has a FAQ or a final CTA, so building those primitives now would be speculative. They move to Phase 2, where Pricing and DownloadDesktop actually need them.

`HeadlineChip` extraction is likewise deferred — neither pilot page uses a mascot chip in its headline. It moves to the first phase that needs one.

## File Structure

| File                                              | Responsibility                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/landing/src/components/site/**`             | Moved from `components/sections/home2/**`. The site's design language.                                        |
| `apps/landing/src/lib/site-tints.ts`              | **New.** Page-key → hero tint map + `getPageTint` resolver. Pure data, no React.                              |
| `apps/landing/src/lib/site-tints.test.ts`         | **New.** Encodes the spec's tint map and binds it to `PAGE_META` and to the real CSS tokens.                  |
| `apps/landing/src/components/site/PageHero.tsx`   | **New.** The one hero primitive.                                                                              |
| `apps/landing/src/components/site/primitives.tsx` | Modified: `MegaCardTint` re-export, `TINT_CLASSES` gains rose/lilac/mint, `FeatureChip` gains `trailingIcon`. |
| `apps/landing/src/pages/Roadmap.tsx`              | Modified: hero → `PageHero`.                                                                                  |
| `apps/landing/src/pages/Changelog.tsx`            | Modified: hero → `PageHero`.                                                                                  |

---

### Task 1: Promote `home2/` to `site/`

Mechanical move, no behaviour change. Done first so every later task lands in the right place.

**Files:**

- Move: `apps/landing/src/components/sections/home2/` → `apps/landing/src/components/site/` (12 files + `widgets/` with 3 files)
- Modify: every file importing from `sections/home2` (at minimum `src/pages/Home.tsx`)

- [ ] **Step 1: Find every importer**

```bash
cd apps/landing
grep -rn "sections/home2" src --include=*.tsx --include=*.ts
```

Record the list. `src/pages/Home.tsx` imports 10 of them; the `home2/*` files import each other and `home2/widgets/*`.

- [ ] **Step 2: Move the directory**

```bash
cd apps/landing
git mv src/components/sections/home2 src/components/site
```

- [ ] **Step 3: Rewrite the import paths**

Every `@/components/sections/home2/X` becomes `@/components/site/X`. Relative imports **inside** the moved directory (e.g. `./primitives`, `./widgets/CliWidget`) are unaffected by the move — do not touch them.

```bash
cd apps/landing
grep -rl "components/sections/home2" src | xargs sed -i '' 's|components/sections/home2|components/site|g'
```

- [ ] **Step 4: Verify nothing still points at the old path**

```bash
cd apps/landing
grep -rn "sections/home2" src || echo "CLEAN"
```

Expected: `CLEAN`

- [ ] **Step 5: Typecheck and build**

```bash
pnpm --filter @memry/landing typecheck
pnpm --filter @memry/landing build
```

Expected: both pass. The build prerenders every route — a broken import fails here, not in the browser.

- [ ] **Step 6: Commit**

```bash
git add -A apps/landing/src
git commit -m "refactor(landing): promote home2 components to site/

These are the site's design language, not homepage-local. Phase 2-4 pages
consume them, so the name was actively misleading. Move only — no behaviour
change."
```

---

### Task 2: Tint map data module

The one place the whole site's colour system lives. Real TDD: this module is pure data, so it gets real tests.

**Files:**

- Create: `apps/landing/src/lib/site-tints.ts`
- Test: `apps/landing/src/lib/site-tints.test.ts`

**Interfaces:**

- Consumes: `PAGE_META` from `src/lib/seo.ts` (a `Record<string, PageMeta>`; keys are page keys like `roadmap`, `aiAgent`, `obsidianAlternative`).
- Produces:
  - `export type MegaCardTint = 'sky' | 'sage' | 'sand' | 'peach' | 'rose' | 'lilac' | 'mint'`
  - `export type HeroTint = MegaCardTint | 'ink'`
  - `export const SITE_TINTS` — page key → `HeroTint`, `as const` so `SITE_TINTS.roadmap` narrows to `'sky'`
  - `export function getPageTint(page: string): HeroTint | undefined`

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/lib/site-tints.test.ts`:

```ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { PAGE_META } from './seo.ts'
import { getPageTint, SITE_TINTS, type HeroTint } from './site-tints.ts'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

// The spec's in-scope page list, written out here on purpose: this file encodes the
// design decision, site-tints.ts encodes the implementation. If they drift, this fails.
const IN_SCOPE_PAGES = [
  'features',
  'useCases',
  'pricing',
  'downloadDesktop',
  'roadmap',
  'changelog',
  'notes',
  'tasks',
  'journal',
  'calendar',
  'inbox',
  'aiAgent',
  'webClipper',
  'cli',
  'compare',
  'privacy',
  'security'
]

// Pages that must stay untinted: home carries the painted wallpaper instead, and the
// legal pages are out of scope entirely.
const UNTINTED_PAGES = ['home', 'terms', 'refund', 'codeSigning']

function tintToken(tint: HeroTint) {
  return tint === 'ink' ? '--color-dark' : `--color-tint-${tint}`
}

describe('site hero tints', () => {
  it('gives every in-scope page a tint', () => {
    for (const page of IN_SCOPE_PAGES) {
      assert.ok(getPageTint(page), `${page} is in scope but has no hero tint`)
    }
  })

  it('only names pages that actually exist', () => {
    for (const page of Object.keys(SITE_TINTS)) {
      assert.ok(PAGE_META[page], `SITE_TINTS names "${page}", which is not a PAGE_META page`)
    }
  })

  it('only uses tints that exist as CSS tokens', () => {
    for (const tint of Object.values(SITE_TINTS)) {
      const token = tintToken(tint)
      assert.ok(css.includes(`${token}:`), `Tint "${tint}" has no ${token} token in index.css`)
    }
  })

  // The landing site is light-only as of 2724277f0 ("feat(landing): remove the dark
  // theme"). There is no .dark block and no @custom-variant dark, so a tint is defined
  // exactly once. This guards the removal: a second definition means a dark block crept
  // back in without the design being reconsidered.
  it('defines every tint exactly once, because the site is light-only', () => {
    for (const tint of new Set(Object.values(SITE_TINTS))) {
      const token = tintToken(tint)
      const occurrences = css.split(`${token}:`).length - 1

      assert.equal(occurrences, 1, `${token} must be defined exactly once (found ${occurrences})`)
    }
  })

  it('routes every alternative page to the comparison tint', () => {
    const alternatives = Object.keys(PAGE_META).filter((page) => page.endsWith('Alternative'))

    assert.ok(alternatives.length > 0, 'expected PAGE_META to define alternative pages')

    for (const page of alternatives) {
      assert.equal(getPageTint(page), 'lilac', `${page} must use the comparison tint`)
    }
  })

  it('leaves the homepage and legal pages untinted', () => {
    for (const page of UNTINTED_PAGES) {
      assert.equal(getPageTint(page), undefined, `${page} must not have a hero tint`)
    }
  })

  it('gives each feature page its own tint', () => {
    const featurePages = [
      'notes',
      'tasks',
      'journal',
      'calendar',
      'inbox',
      'aiAgent',
      'webClipper',
      'cli'
    ]
    const tints = featurePages.map((page) => getPageTint(page))

    assert.equal(new Set(tints).size, featurePages.length, 'feature page tints must be unique')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @memry/landing test
```

Expected: FAIL — `Cannot find module './site-tints.ts'`

- [ ] **Step 3: Write the implementation**

Create `apps/landing/src/lib/site-tints.ts`:

```ts
/**
 * The site's hero colour system, in one place.
 *
 * Rule (see docs/superpowers/specs/2026-07-14-landing-site-design-consistency-design.md):
 * feature pages get unique tints — inside a feature, colour answers "which feature".
 * Other families deliberately reuse — in marketing, colour answers "which category".
 * Seven tints across eighteen pages makes collisions arithmetic; the rule is what makes
 * them meaningful. Colliding pairs never share a context.
 *
 * Keys are PAGE_META page keys (see lib/seo.ts), not routes — the same key you pass to
 * <PageHead page="..." />. site-tints.test.ts binds the two maps together.
 *
 * `home` is deliberately absent: it carries the painted landscape wallpaper instead, and
 * that stays exclusive to the homepage.
 */
export type MegaCardTint = 'sky' | 'sage' | 'sand' | 'peach' | 'rose' | 'lilac' | 'mint'

/** `ink` is the CLI page's terminal hero — a dark surface, not a pastel tint. */
export type HeroTint = MegaCardTint | 'ink'

/** Every *Alternative page resolves here: neutral beside competitor logos. */
const COMPARISON_TINT = 'lilac' satisfies HeroTint

export const SITE_TINTS = {
  // Feature pages — unique tints, because here colour is wayfinding
  notes: 'sky', // writing surface; shares home's tint on purpose — Notes is the heart
  tasks: 'sage', // green = done/action, matching --color-sage
  journal: 'sand', // paper warmth, daily ritual
  calendar: 'mint', // adjacent to sage but distinct — kin to Tasks, not the same
  inbox: 'lilac', // capture/triage — where unsorted things live
  aiAgent: 'peach', // terracotta family = the brand's "smart" accent
  webClipper: 'rose', // the only surface pointing outward
  cli: 'ink', // the terminal page's hero is a terminal

  // Conversion — terracotta CTAs are strongest on peach
  pricing: 'peach',
  downloadDesktop: 'peach',

  // Discovery
  features: 'sand',
  useCases: 'sand',

  // Timeline
  roadmap: 'sky',
  changelog: 'sky',

  // Trust — carries the homepage PrivacyShowcase link visually
  privacy: 'mint',
  security: 'mint',

  // Comparison
  compare: COMPARISON_TINT
} as const satisfies Record<string, HeroTint>

/**
 * Resolve a page key to its hero tint, or undefined if the page has no tinted hero.
 *
 * The 16 *Alternative pages are generated from one template, so they resolve by rule
 * rather than by sixteen identical entries.
 */
export function getPageTint(page: string): HeroTint | undefined {
  if (page.endsWith('Alternative')) return COMPARISON_TINT

  return (SITE_TINTS as Record<string, HeroTint>)[page]
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @memry/landing test
```

Expected: PASS. Total test count rises from 50 to 57.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @memry/landing typecheck
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/src/lib/site-tints.ts apps/landing/src/lib/site-tints.test.ts
git commit -m "feat(landing): central hero tint map

One place for the site's colour system, keyed by PAGE_META page key. Tests bind
it to PAGE_META and to the real CSS tokens, so a typo or a missing page fails
the suite rather than shipping a grey hero."
```

---

### Task 3: `PageHero` primitive

The one hero. Replaces all three of today's archetypes.

**Files:**

- Create: `apps/landing/src/components/site/PageHero.tsx`
- Modify: `apps/landing/src/components/site/primitives.tsx`

**Interfaces:**

- Consumes: `HeroTint`, `MegaCardTint` from `@/lib/site-tints`; `cn` from `@/lib/utils`.
- Produces: `export function PageHero(props: PageHeroProps)` with
  `{ tint: HeroTint; eyebrow?: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode; visual?: ReactNode; className?: string }`

- [ ] **Step 1: Point `primitives.tsx` at the shared tint vocabulary**

In `apps/landing/src/components/site/primitives.tsx`, replace the local `MegaCardTint` type and its `TINT_CLASSES` map. The type now lives in `lib/site-tints.ts`; `primitives.tsx` re-exports it so existing importers keep working.

Replace:

```tsx
export type MegaCardTint = 'sky' | 'sage' | 'sand' | 'peach'

const TINT_CLASSES: Record<MegaCardTint, string> = {
  sky: 'bg-tint-sky',
  sage: 'bg-tint-sage',
  sand: 'bg-tint-sand',
  peach: 'bg-tint-peach'
}
```

with:

```tsx
import type { MegaCardTint } from '@/lib/site-tints'

export type { MegaCardTint }

/** Exported so PageHero can extend it with the `ink` surface rather than restate it. */
export const TINT_CLASSES: Record<MegaCardTint, string> = {
  sky: 'bg-tint-sky',
  sage: 'bg-tint-sage',
  sand: 'bg-tint-sand',
  peach: 'bg-tint-peach',
  rose: 'bg-tint-rose',
  lilac: 'bg-tint-lilac',
  mint: 'bg-tint-mint'
}
```

`Record<MegaCardTint, string>` makes TypeScript enforce completeness — a missing tint fails typecheck.

- [ ] **Step 2: Add `trailingIcon` to `FeatureChip`**

Roadmap and Changelog both hand-roll a pill link with a trailing arrow. `FeatureChip` already handles internal-`Link`-vs-external-`<a>`; it only lacks a trailing slot.

In the same file, change the `FeatureChipProps` interface and the `content` fragment:

```tsx
export interface FeatureChipProps {
  icon?: ReactNode
  label: string
  href?: string
  trailingIcon?: ReactNode
  className?: string
}
```

```tsx
const content = (
  <>
    {icon && (
      <span aria-hidden className="flex shrink-0 items-center justify-center">
        {icon}
      </span>
    )}
    <span className="whitespace-nowrap">{label}</span>
    {trailingIcon && (
      <span aria-hidden className="flex shrink-0 items-center justify-center">
        {trailingIcon}
      </span>
    )}
  </>
)
```

Add `trailingIcon` to the destructured params: `function FeatureChip({ icon, label, href, trailingIcon, className }: FeatureChipProps)`.

- [ ] **Step 3: Write `PageHero`**

Create `apps/landing/src/components/site/PageHero.tsx`:

```tsx
import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { HeroTint } from '@/lib/site-tints'
import { TINT_CLASSES } from '@/components/site/primitives'

const EASE = [0.16, 1, 0.3, 1] as const

// One synchronized entrance, mirroring Hero2: every layer materializes together
// rather than staggering in.
const HERO_IN = { duration: 0.7, delay: 0.1, ease: EASE }

// The seven pastel tints come straight from the mega-card map — restating them here
// would be the same duplication this layer exists to kill. `ink` is hero-only: it is a
// dark surface, not a pastel, and no MegaCard uses it.
const HERO_TINT_CLASSES: Record<HeroTint, string> = {
  ...TINT_CLASSES,
  ink: 'bg-dark'
}

export interface PageHeroProps {
  tint: HeroTint
  eyebrow?: string
  title: ReactNode
  sub?: ReactNode
  /** CTA / pill-link slot, laid out as a centered wrapping row. */
  actions?: ReactNode
  /** Optional screenshot, mock or card row, sitting below the copy inside the panel. */
  visual?: ReactNode
  className?: string
}

/**
 * The sub-page hero: the same inset rounded mega-panel as the homepage, in a flat tint
 * instead of the painted landscape. The wallpaper stays exclusive to Hero2 — repeating
 * it across sixteen pages would strip the homepage of its entrance and ship a ~2MB
 * background on every route.
 *
 * Top padding is deliberately shorter than Hero2's (pt-24/md:pt-32 vs pt-28/md:pt-40):
 * home is the entrance and stays tallest; sub-pages reach their content faster. It still
 * clears the fixed nav pill, which floats over the panel.
 */
export function PageHero({ tint, eyebrow, title, sub, actions, visual, className }: PageHeroProps) {
  const isInk = tint === 'ink'

  return (
    <section className="px-3 pb-4 pt-3 sm:px-6 md:pb-6">
      <div
        className={cn(
          'relative mx-auto w-full overflow-hidden rounded-3xl border pb-8 md:pb-14',
          isInk ? 'border-dark-border' : 'border-ink/5',
          HERO_TINT_CLASSES[tint],
          className
        )}
      >
        <div className="relative z-10 px-6 pt-24 text-center sm:px-10 md:pt-32">
          {eyebrow && (
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={HERO_IN}
              className={cn(
                'mb-4 font-mono-accent text-[11px] uppercase tracking-[0.2em]',
                isInk ? 'text-terracotta-glow' : 'text-terracotta'
              )}
            >
              {eyebrow}
            </motion.p>
          )}

          <motion.h1
            initial={{ opacity: 0, y: 18, filter: 'blur(10px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={HERO_IN}
            className={cn(
              'display-hero mx-auto max-w-4xl text-balance',
              isInk ? 'text-ink-inverted' : 'text-ink'
            )}
          >
            {title}
          </motion.h1>

          {sub && (
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={HERO_IN}
              className={cn(
                'mx-auto mt-6 max-w-2xl text-base leading-relaxed md:text-lg',
                isInk ? 'text-dark-muted' : 'text-muted'
              )}
            >
              {sub}
            </motion.p>
          )}

          {actions && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={HERO_IN}
              className="mt-9 flex flex-wrap items-center justify-center gap-3"
            >
              {actions}
            </motion.div>
          )}
        </div>

        {visual && (
          <motion.div
            initial={{ opacity: 0, y: 72 }}
            animate={{ opacity: 1, y: 0 }}
            transition={HERO_IN}
            className="relative z-10 mx-auto mt-12 w-4/5 max-w-[57.6rem] md:mt-16"
          >
            {visual}
          </motion.div>
        )}
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Typecheck and build**

```bash
pnpm --filter @memry/landing typecheck
pnpm --filter @memry/landing build
```

Expected: both pass. `PageHero` has no consumer yet — this only proves it compiles and that the `MegaCardTint` widening did not break `MegaCard`'s existing callers.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @memry/landing test
```

Expected: PASS, still 57.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/src/components/site/PageHero.tsx apps/landing/src/components/site/primitives.tsx
git commit -m "feat(landing): PageHero primitive + widen tint vocabulary

One inset tint panel to replace the three hero archetypes in circulation.
MegaCardTint moves to lib/site-tints and gains rose/lilac/mint; FeatureChip
gains a trailing-icon slot for hero pill links."
```

---

### Task 4: Roadmap onto `PageHero`

**Files:**

- Modify: `apps/landing/src/pages/Roadmap.tsx:276-311` (the `RoadmapPage` wrapper and its hero `motion.section`)

**Interfaces:**

- Consumes: `PageHero` from `@/components/site/PageHero`, `FeatureChip` from `@/components/site/primitives`, `SITE_TINTS` from `@/lib/site-tints`.

**Preserve exactly:** the first pill links to `${GITHUB_URL}/releases` while being labelled "Changelog". That looks like a bug — a `/changelog` page exists. **Do not fix it here.** This is a re-skin; behaviour changes belong in their own commit.

- [ ] **Step 1: Replace the hero section**

Delete the `motion.section` at lines 281-311 and restructure `RoadmapPage` so `PageHero` sits outside `Container`:

```tsx
export function RoadmapPage() {
  return (
    <>
      <PageHead page="roadmap" />
      <PageHero
        tint={SITE_TINTS.roadmap}
        eyebrow="Building in public"
        title="Roadmap"
        sub="What is available, what is active, and what is planned next. This is direction, not a release promise."
        actions={
          <>
            <FeatureChip
              label="Changelog"
              href={`${GITHUB_URL}/releases`}
              trailingIcon={<ArrowRight className="h-4 w-4" />}
            />
            <FeatureChip
              label="Request a feature"
              href={`${GITHUB_URL}/issues`}
              trailingIcon={<ArrowRight className="h-4 w-4" />}
            />
          </>
        }
      />
      <main className="pb-24 pt-4">
        <Container size="md">
          <section className="border-b border-border py-12">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[140px_1fr] md:gap-10">
              <div className="md:pt-5">
                <StatusPill label="Active" tone="sage" count={ACTIVE_ITEMS.length} />
              </div>
              <RoadmapList items={ACTIVE_ITEMS} />
            </div>
          </section>

          <section className="border-b border-border py-12">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[140px_1fr] md:gap-10">
              <div className="md:pt-5">
                <StatusPill label="Planned" tone="terracotta" count={PLANNED_ITEMS.length} />
              </div>
              <RoadmapList items={PLANNED_ITEMS} />
            </div>
          </section>

          <section className="pt-12">
            <div className="mb-6">
              <StatusPill label="Launched" tone="muted" count={TOTAL_LAUNCHED} />
            </div>

            <motion.div
              variants={stagger}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: '-60px' }}
              className="space-y-10"
            >
              {LAUNCHED_GROUPS.map((group) => (
                <div
                  key={group.period}
                  className="grid grid-cols-1 gap-3 md:grid-cols-[140px_1fr] md:gap-10"
                >
                  <h3 className="font-mono-accent text-xs uppercase tracking-[0.18em] text-muted md:pt-5">
                    {group.period}
                  </h3>
                  <ul className="border-t border-border/60">
                    {group.items.map((item) => (
                      <RoadmapRow key={item.title} item={item} />
                    ))}
                  </ul>
                </div>
              ))}
            </motion.div>
          </section>
        </Container>
      </main>
    </>
  )
}
```

Note the `main` changed from `pt-32 pb-24 md:pt-40` to `pb-24 pt-4` — the hero panel now owns the top spacing.

- [ ] **Step 2: Fix the imports**

Add:

```tsx
import { PageHero } from '@/components/site/PageHero'
import { FeatureChip } from '@/components/site/primitives'
import { SITE_TINTS } from '@/lib/site-tints'
```

Then remove any import left unused by the deleted hero — check `BLUR_REVEAL_INITIAL`, `BLUR_REVEAL_ANIMATE`, `BLUR_REVEAL_TRANSITION` (the hero was their only consumer). Keep `motion`, `stagger` and `fadeUp`: the Launched section still uses them.

```bash
cd apps/landing
grep -n "BLUR_REVEAL" src/pages/Roadmap.tsx
```

If the only hits are the import line, delete the import.

- [ ] **Step 3: Lint and typecheck**

```bash
pnpm --filter @memry/landing lint
pnpm --filter @memry/landing typecheck
```

Expected: both pass. Lint catches any now-unused import.

- [ ] **Step 4: Build**

```bash
pnpm --filter @memry/landing build
```

Expected: pass, `/roadmap` prerenders.

- [ ] **Step 5: Look at it**

```bash
pnpm dev:landing
```

Open `/roadmap`. Check, in this order:

1. The sky panel is inset from the viewport edges with rounded corners, and the nav pill floats over it without colliding with the eyebrow.
2. Both pill links render with a trailing arrow and hover-lift.
3. Narrow to ~375px — the panel keeps its inset, the headline does not overflow, the pills wrap.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/src/pages/Roadmap.tsx
git commit -m "feat(landing): Roadmap onto PageHero

First consumer of the shared hero. Drops the bespoke centered+border-b
archetype and the hand-rolled pill links."
```

---

### Task 5: Changelog onto `PageHero`

Changelog is Roadmap's twin — same wrapper, same eyebrow/h1/sub/pill-row shape. This task is the proof that one `PageHero` call resolves both.

**Files:**

- Modify: `apps/landing/src/pages/Changelog.tsx:189-228` (the `ChangelogPage` wrapper and its hero `motion.section`)

**Interfaces:**

- Consumes: same as Task 4. Nothing new is built here — if this task needs a new prop, the abstraction is wrong; stop and say so.

- [ ] **Step 1: Replace the hero section**

```tsx
export function ChangelogPage() {
  return (
    <>
      <PageHead page="changelog" />
      <PageHero
        tint={SITE_TINTS.changelog}
        eyebrow="Release notes"
        title="Changelog"
        sub="Major memrynote milestones from the first desktop scaffold on December 1, 2025 to the current launch push. Small fixes, copy changes, and operational release notes stay in GitHub."
        actions={
          <>
            <FeatureChip
              label="GitHub releases"
              href={`${GITHUB_URL}/releases`}
              trailingIcon={<ArrowRight className="h-4 w-4" />}
            />
            <FeatureChip
              label="Roadmap"
              href="/roadmap"
              trailingIcon={<ArrowRight className="h-4 w-4" />}
            />
          </>
        }
      />
      <main className="pb-24 pt-4">
        <Container size="md">
          <section className="divide-y divide-border">
            {CHANGELOG_ENTRIES.map((entry) => {
              const Icon = entry.icon

              return (
                <article key={`${entry.period}-${entry.title}`} className="py-10">
                  <div className="grid gap-5 md:grid-cols-[150px_1fr] md:gap-10">
                    <div>
                      <p className="font-mono-accent text-xs uppercase tracking-[0.18em] text-muted">
                        {entry.period}
                      </p>
                    </div>
                    <div>
                      <div className="flex gap-4">
                        <div className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-paper-alt text-terracotta">
                          <Icon className="h-5 w-5" aria-hidden />
                        </div>
                        <div>
                          <h2 className="font-serif text-2xl leading-tight text-ink md:text-3xl">
                            {entry.title}
                          </h2>
                          <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">
                            {entry.summary}
                          </p>
                        </div>
                      </div>
                      <ul className="mt-6 grid gap-3 text-base leading-relaxed text-muted">
                        {entry.highlights.map((highlight) => (
                          <li key={`${entry.period}-${highlight}`} className="flex gap-3">
                            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-terracotta/70" />
                            <span>{highlight}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </article>
              )
            })}
          </section>
        </Container>
      </main>
    </>
  )
}
```

Note `FeatureChip` handles the internal-vs-external split itself, so the `Link` import for `/roadmap` is no longer needed here.

- [ ] **Step 2: Fix the imports**

Add the same three imports as Task 4. Then remove what the deleted hero orphaned — likely `BLUR_REVEAL_*` and `Link`:

```bash
cd apps/landing
grep -n "BLUR_REVEAL\|from 'react-router-dom'\|motion" src/pages/Changelog.tsx
```

The entry list uses no motion, so `motion` itself may now be unused — check before deleting.

- [ ] **Step 3: Lint, typecheck, build**

```bash
pnpm --filter @memry/landing lint
pnpm --filter @memry/landing typecheck
pnpm --filter @memry/landing build
```

Expected: all pass.

- [ ] **Step 4: Look at it**

```bash
pnpm dev:landing
```

Open `/changelog`, then `/roadmap`, then back. The two heroes must read as the same component with different words — same panel inset, same corner radius, same type scale, same sky tint. That resemblance is the whole point of the phase; if they differ, `PageHero` is leaking page-specific styling and needs fixing before Phase 2.

Check ~375px as in Task 4.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/pages/Changelog.tsx
git commit -m "feat(landing): Changelog onto PageHero

Roadmap's twin, resolved by the same primitive with no new props — the
foundation's first real proof."
```

---

## Phase exit criteria

Before Phase 2 is planned, all of these must hold:

- [ ] `pnpm --filter @memry/landing lint` passes
- [ ] `pnpm --filter @memry/landing typecheck` passes
- [ ] `pnpm --filter @memry/landing test` passes (57 tests)
- [ ] `pnpm --filter @memry/landing build` passes, prerendering all routes
- [ ] `/roadmap` and `/changelog` read as the same component, at 375px and desktop
- [ ] `grep -rn "sections/home2" apps/landing/src` returns nothing
- [ ] Task 5 required **no new `PageHero` props**

The last one is the real gate. `PageHero` was designed against three archetypes but validated against one shape (centered copy + pill links, no `visual`). Phase 2 is where `visual` and `ink` get their first real consumers — Pricing's tier cards, DownloadDesktop's screenshot. If Phase 2's first page needs structural new props, `PageHero` is wrong and it is cheaper to learn that against Pricing than against page fourteen.

## What Phase 2 inherits

- `PageHero` with `visual` and `ink` **unexercised**. Both are speculative until a page uses them; `ink` is not proven until Phase 4's CLI page.
- `Faq`, `FinalCta`, `HeadlineChip` still unbuilt — deferred here, needed there.
- The `MegaCard` tint widening is live but rose/lilac/mint have no `MegaCard` consumer yet.
