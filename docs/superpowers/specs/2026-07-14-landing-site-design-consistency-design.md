# Landing site design consistency — design

Date: 2026-07-14
Branch: `landing-craft-redesign` (extends DRAFT PR #738)
Status: approved, ready for implementation planning

## Problem

The Craft-style homepage redesign landed a complete design language — an inset rounded
hero mega-panel, pastel `bg-tint-*` mega-cards, mascot illustrations, Manrope display
type, founder notes. **None of it reaches any other page.**

Audit of `apps/landing/src/pages/*` confirms zero adoption outside `Home.tsx` and
`components/sections/home2/*`:

- **Three unrelated hero archetypes** are in circulation: centered + `border-b`
  (Roadmap, Changelog — verbatim copies of each other), left-aligned `max-w-3xl`
  (ComparePage, AlternativePage), and rich/one-off (Pricing plain text, DownloadDesktop
  radial-glow, UseCases dark marquee). `Features.tsx` has **no hero at all** — it opens
  `pt-24` straight into a section.
- **Six feature pages are clones.** Notes, Tasks, Journal, Calendar, Inbox, AIAgent are
  ~1,100 lines each with an identical 11-section skeleton. Their 5-section tail
  (`WorksWithRest` / `UseCases` / `MoreFeatures` / `Faq` / `FinalCta`) is byte-identical
  apart from copy strings and identifiers (`notes-faq-${i}` → `tasks-faq-${i}`).
  ~1,400 lines of pure duplication.
- Section rhythm is hand-rolled everywhere as `py-24 md:py-28` + `bg-paper-alt/55` —
  exactly what `HomeSection` / `MegaCard` already model.
- Each page redeclares its own `Eyebrow`, its own `EASE_OUT_EXPO` / `fadeUp` / `stagger`
  motion constants, and its own `terracotta | sage | amber` tone map (~15 copies of a
  thing `MegaCardTint` already models).

Net effect: a visitor who lands on the new homepage and clicks anything arrives on what
reads as a different website.

## Decisions

| #   | Decision      | Choice                                                                                                                                                                       |
| --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Depth         | **Re-skin + de-dup.** Section structure and copy stay; visual language and the duplicated skeleton change.                                                                   |
| 2   | Sub-page hero | **Tint panel.** Same inset panel geometry, display type and mascot chip as home — solid `bg-tint-*` instead of the painted landscape. The wallpaper stays exclusive to home. |
| 3   | Scope         | 18 page files / ~33 routes (below).                                                                                                                                          |
| 4   | Architecture  | Primitive library for marketing pages + slot-based `FeaturePageShell` for the six clones.                                                                                    |
| 5   | Tint map      | Feature pages get unique tints; other families deliberately reuse.                                                                                                           |
| 6   | Phasing       | 4 phases, 4 commits, verified independently.                                                                                                                                 |
| 7   | Branch        | Same branch, phased commits, PR #738 grows.                                                                                                                                  |

**On decision 2:** repeating the landscape across 16 pages would strip the homepage hero
of its specialness and ship a ~2MB background on every route. A per-page tint keeps the
family resemblance, makes colour do wayfinding work, and costs nothing — every tint
already exists as a token.

**On decision 4:** the tail duplication is real and mechanical, so it dies in config. The
middle showcases are genuinely different hand-built mock-UI (`KanbanViewCard`,
`MonthMiniMock`, `ClusterPanelMock`, …); forcing those into config would produce a monster
config type. Abstract where duplication is real, stay free-form where it isn't.

**On decision 7:** the homepage redesign is not merged. Merging #738 alone would ship
precisely the bug being fixed — new homepage, old sub-pages. The `site/` promotion also
moves `home2/*` files, so it touches that work regardless. Accepted cost: PR grows to
~10k lines.

## Scope

**In — 18 files, ~33 routes:**

| Family            | Pages                                                                            |
| ----------------- | -------------------------------------------------------------------------------- |
| Marketing         | `Features`, `Pricing`, `DownloadDesktop`, `Roadmap`, `UseCases`, `Changelog`     |
| Feature sub-pages | `Notes`, `Tasks`, `Journal`, `Calendar`, `Inbox`, `AIAgent`, `WebClipper`, `Cli` |
| Comparison        | `ComparePage`, `AlternativePage` (one template → 16 routes)                      |
| Trust             | `Privacy`, `Security`                                                            |

**Out:** `Terms`, `Refund`, `CodeSigningPolicy` (legal boilerplate), `Login`, `Checkout`,
`Account/*`, `NotFound`, `AuthCallback` (app surfaces, different job).

Comparison pages are in because they are the site's SEO entry point — visitors arrive from
Google without ever seeing the homepage, so consistency matters most there, and one
template edit reskins 16 routes. Trust pages are in because `PRODUCT.md` states "privacy is
the product"; they are the proof pages for the product's central claim and the homepage
`PrivacyShowcase` links directly to them.

## The shared layer

`components/sections/home2/` is now a misnomer — it is the site's design language, not
homepage-local. It is promoted to **`components/site/`**, including `home2/widgets/` →
`site/widgets/`.

**Promoted unchanged:** `MegaCard`, `SectionTitle`, `FounderNote`, `HomeSection`,
`FeatureChip`, `AgentChatWidget`, `CliWidget`, `NoteEditorWidget`.

**Promoted out of `Hero2.tsx`:** `HeadlineChip` (currently file-local) becomes a shared
export so any page headline can carry a mascot chip.

**New primitives:**

- `PageHero` — decision 2 made real. Kills all three current hero archetypes.
- `Faq` — accordion driven by `items`. Currently duplicated 7×.
- `FinalCta` — wraps the existing `shared/DownloadCTA`. Currently hand-rolled on 8 pages.
- `IntegrationsRow`, `UseCasesRow`, `MoreFeaturesGrid` — the rest of the feature tail.
- `FeaturePageShell` — hero + anchor grid + tail from config; showcases as `children`.

**Deleted duplication:** per-page `Eyebrow`, per-page motion constants, and the ~15 copies
of the `terracotta | sage | amber` tone map.

### `MegaCardTint` extension

`MegaCardTint` currently covers `sky | sage | sand | peach`. It extends to include
`rose | lilac | mint` — all three tokens already exist in `index.css` with light and dark
values, so this is a type-and-map change only. `TINT_CLASSES` gains the three entries.

A separate `HeroTint = MegaCardTint | 'ink'` covers the CLI hero. `ink` maps to the
existing `--color-dark` surface and forces `text-ink-inverted` for its subtree.

### `PageHero` API

```tsx
export interface PageHeroProps {
  tint: HeroTint
  eyebrow?: string
  title: ReactNode // may contain <HeadlineChip>
  sub?: ReactNode
  actions?: ReactNode // CTA slot
  visual?: ReactNode // screenshot / cards / mock — optional
  className?: string
}
```

Geometry is inherited from `Hero2`: outer `section` at `px-3 pb-4 pt-3 sm:px-6 md:pb-6`,
inner panel at `relative mx-auto w-full overflow-hidden rounded-3xl border border-ink/5
pb-8 md:pb-14` with the tint class, copy block at `relative z-10 px-6 text-center sm:px-10`.

**Sub-page heroes are deliberately shorter than home:** top padding is `pt-24 md:pt-32`
against Hero2's `pt-28 md:pt-40`. Home is the entrance and stays the tallest; sub-pages
get to the content faster. `Hero2` keeps its own padding and is **not** refactored to use
`PageHero` — it carries wallpaper, paper collage and demo-dialog wiring that no other page
needs, and folding those into `PageHero` as dead props would be the abstraction trap this
design is trying to avoid. The two share `HeadlineChip` and the tint tokens; that is the
right amount of sharing.

### `FeaturePageShell` API

```tsx
export interface FeaturePageConfig {
  page: PageHeadKey
  tint: HeroTint
  hero: {
    eyebrow?: string
    title: ReactNode
    sub?: ReactNode
    actions?: ReactNode
    visual?: ReactNode
  }
  anchors: AnchorCard[]
  integrations: Integration[]
  useCases: UseCase[]
  moreFeatures: Feature[]
  faq: FaqItem[]
  cta: { title: ReactNode; sub?: ReactNode }
}
```

```tsx
<FeaturePageShell config={NOTES_CONFIG}>
  <WritingSurface />
  <ConnectEveryIdea />
  <PropertiesSection />
  <StructureThinking />
</FeaturePageShell>
```

Render order — matching today's skeleton exactly, so this is a refactor, not a
re-authoring:

```
PageHead → PageHero → AnchorGrid → {children} → IntegrationsRow
  → UseCasesRow → MoreFeaturesGrid → Faq → FinalCta
```

`children` covers the 3–4 bespoke showcases **and** the per-page structure section
(`StructureThinking` / `StructureRitual` / `StructureSection`), which differs enough per
page to stay free-form.

## Tint map

Seven tints, eighteen pages — collisions are arithmetic, not sloppiness. The rule that
makes them meaningful: **feature pages get unique tints** (inside a feature, colour answers
"which feature"), **other families deliberately reuse** (in marketing, colour answers
"which category"). Colliding pairs never appear side by side and never share a context.

| Tint    | Pages                     | Why                                                                                               |
| ------- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `sky`   | `/notes`                  | Writing surface. Shares home's hero tint — Notes is the product's heart; the echo is intentional. |
| `sage`  | `/tasks`                  | Green = done/action. `--color-sage` is already the product's "completed" colour.                  |
| `sand`  | `/journal`                | Paper warmth, daily ritual.                                                                       |
| `mint`  | `/calendar`               | Adjacent to sage but distinct — Tasks and Calendar are kin, not the same.                         |
| `lilac` | `/inbox`                  | Capture/triage — where unsorted things live.                                                      |
| `peach` | `/ai-agent`               | Terracotta family = the brand's "smart" accent.                                                   |
| `rose`  | `/web-clipper`            | The only surface pointing outward.                                                                |
| `ink`   | `/cli`                    | **Special case** — the terminal page's hero _is_ a terminal.                                      |
| `peach` | `/pricing`, `/download`   | Conversion. Terracotta CTAs are strongest on peach.                                               |
| `sand`  | `/features`, `/use-cases` | Discovery.                                                                                        |
| `sky`   | `/roadmap`, `/changelog`  | Timeline.                                                                                         |
| `mint`  | `/privacy`, `/security`   | Trust. Carries the homepage `PrivacyShowcase` link visually.                                      |
| `lilac` | `/compare`, `/vs/*`       | Comparison — must read neutral beside competitor logos.                                           |

Three entries are more than paint:

- **`/cli` → ink.** Nearly free: the page already has a `Term` terminal renderer and
  `zone-dark` already exists. It is also the one thing breaking the palette's monotony.
- **`/features` → sand.** This page currently has no hero at all — the site's weakest
  entry gets one for the first time.
- **`/roadmap` + `/changelog` → sky.** Already verbatim copies; one `PageHero` call
  resolves both.

## Phasing

Four phases, four commits on `landing-craft-redesign`. Each verifies independently.

**Phase 1 — foundation + pilot.** Build `site/`: promote the primitives and widgets, write
`PageHero`, `Faq`, `FinalCta`, extend `MegaCardTint`. Pilot on **Roadmap + Changelog** —
the site's two leanest pages (~130 and ~85 lines of JSX) and copies of each other, so the
first phase proves one `PageHero` call resolves two pages. Small, low-risk, system visible
live.

**Phase 2 — marketing.** `Features` (gets a hero for the first time), `UseCases`,
`Pricing`, `DownloadDesktop`. The heaviest bespoke load: Pricing ~985 lines, Download ~650.
Pricing's dark `BelieverNarrative` zone and Download's radial-glow both die — each is an
escapee from the system.

**Phase 3 — feature shell + six clones.** `FeaturePageShell` + tail primitives. `Notes`
first as the reference, then `Tasks`, `Journal`, `Calendar`, `Inbox`, `AIAgent`. This is
where ~1,400 lines die. `AIAgent` is wired to the existing `AgentChatWidget` here.

**Phase 4 — remainder.** `WebClipper`, `Cli` (ink hero + `CliWidget`), `ComparePage` +
`AlternativePage` (16 routes), `Privacy`, `Security`.

### Widget reuse

`AgentChatWidget`, `CliWidget` and `NoteEditorWidget` are **not orphaned** — `ConnectedShowcase`
renders the first two and `NotesShowcase` renders the third, so all three are live on the
homepage today. Only the feature pages ignore them, having hand-built their own equivalents.
Wiring `/ai-agent`, `/cli` and `/notes` to them therefore shows the _same_ widget the
homepage already shows — which is the consistency argument in its purest form — while
deleting hand-rolled mock JSX.

## Constraints

- **RTL / logical properties.** All new code uses logical Tailwind classes — `ms/me`,
  `ps/pe`, `start/end`, `text-start/end`, `border-s/e`, `rounded-s/e-*`. The pre-commit
  renderer guard rejects an entire file on any physical class, so a touched file must be
  clean throughout, not just in the new lines.
- **WCAG AA** on every tint. Tints are light, so `text-ink` clears AA on all seven. The
  `ink` hero forces `text-ink-inverted`. The pre-existing `#b33c00` H1 deviation is
  carried forward, not widened.
- **Reduced motion.** `MotionConfig reducedMotion` is already site-wide; new motion rides
  it and gates hover transforms behind `motion-safe:`.
- **Dark mode.** Every tint already has a deep desaturated dark equivalent. No new tokens.
- **No new routes.** Route set is unchanged, so the `ROUTE_MAP` / `entry-server` SSG
  gotcha is not in play — but `build` prerenders all ~33 routes, which catches it anyway.
- **Copy is preserved.** This is a re-skin: headline and body copy carry over unless a
  section is deleted outright. The example headlines in the tint mockups are illustrative,
  not a copy rewrite mandate.

## Verification

Per phase:

```bash
pnpm lint
pnpm typecheck
pnpm --filter @memry/landing build   # typecheck + vite build + prerender all ~33 routes
```

The prerender step is the real gate — it renders every route for real, so a broken page
fails the build rather than shipping.

Manual pass per phase: each touched route in light **and** dark, at mobile and desktop
widths. `pnpm dev:landing`.

Docs gate does not apply — `scripts/docs-impact.mjs` routes on desktop/sync-server changes;
this is landing-only.

## Non-goals

- No copy rewriting, no new sections, no new content decisions. Structure and words stay.
- No refactoring of `Hero2` into `PageHero` (see rationale above).
- No touching legal or app-surface pages.
- No new design tokens, no new palette, no font changes.
- No mascot creation unless a hero chip needs one that does not exist; if so, follow
  `apps/landing/scripts/mascots/README.md`.

## Risks

- **PR size.** ~10k lines. Mitigated by four self-contained, independently verified
  commits and by the fact that ~1,400 of those lines are deletions.
- **`FeaturePageShell` rigidity.** If a page's config starts sprouting booleans that toggle
  tail layout, the abstraction is wrong — that is the signal to give that page its
  primitives directly instead. Phase 3 does Notes first specifically to find this early.
- **Tint collisions reading as accidents.** Mitigated by the family rule; if a collision
  ever becomes visible in one viewport, the losing page moves to the unused slot.
