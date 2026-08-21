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
 * The conversion pages (`pricing`, `downloadDesktop`), the timeline pages (`roadmap`,
 * `changelog`) and `features` are absent too: their heroes run untinted on the page
 * ground, so the plan cards, the download buttons and each page's own content colour
 * carry them alone.
 */
export type MegaCardTint = 'sky' | 'sage' | 'sand' | 'peach' | 'rose' | 'lilac' | 'mint'

/** `ink` is the CLI page's terminal hero — a dark surface, not a pastel tint. */
export type HeroTint = MegaCardTint | 'ink'

/** Every *Alternative page resolves here: neutral beside competitor logos. */
const COMPARISON_TINT = 'lilac' satisfies HeroTint

/**
 * Tint → Tailwind background class. Lives here rather than in primitives.tsx because it
 * is pure data: a component file that also exports constants breaks fast refresh.
 * `Record<MegaCardTint, string>` makes TypeScript enforce completeness; site-tints.test.ts
 * catches the mismatch TypeScript cannot see (e.g. `sky: 'bg-tint-sage'`).
 */
export const TINT_CLASSES: Record<MegaCardTint, string> = {
  sky: 'bg-tint-sky',
  sage: 'bg-tint-sage',
  sand: 'bg-tint-sand',
  peach: 'bg-tint-peach',
  rose: 'bg-tint-rose',
  lilac: 'bg-tint-lilac',
  mint: 'bg-tint-mint'
}

/**
 * The hero surface map: the seven pastels plus `ink`. Spread from TINT_CLASSES rather
 * than restated — duplicating it is the exact habit this layer exists to end.
 */
export const HERO_TINT_CLASSES: Record<HeroTint, string> = {
  ...TINT_CLASSES,
  ink: 'bg-dark'
}

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

  // Discovery
  useCases: 'sand',

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
