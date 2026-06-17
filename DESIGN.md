---
name: Memry
description: A calm, private, offline-first second brain — paper surfaces, editorial type, flat-first depth.
colors:
  terracotta: '#ff671a'
  terracotta-deep: '#b33c00'
  terracotta-glow: '#ff894d'
  paper: '#f6f5f0'
  paper-white: '#ffffff'
  surface: '#efefe9'
  surface-active: '#e4e4de'
  ink: '#1a1a1a'
  ink-secondary: '#4a4a4a'
  ink-tertiary: '#8c8c8c'
  charcoal: '#191919'
  charcoal-surface: '#222222'
  charcoal-ink: '#bcbab6'
  border: '#e4e4de'
  tint-indigo: '#6366f1'
  sage: '#5b7f6a'
  destructive: '#dc2626'
typography:
  display:
    fontFamily: 'Playfair Display Variable, Crimson Pro Variable, Georgia, serif'
    fontSize: 'clamp(2rem, 5vw, 3.5rem)'
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: '-0.02em'
  headline:
    fontFamily: 'Space Grotesk Variable, system-ui, sans-serif'
    fontSize: '1.5rem'
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: '-0.01em'
  title:
    fontFamily: 'Crimson Pro Variable, Georgia, serif'
    fontSize: '1.125rem'
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 'normal'
  body:
    fontFamily: 'ui-sans-serif, -apple-system, system-ui, Segoe UI Variable, sans-serif'
    fontSize: '0.875rem'
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 'normal'
  label:
    fontFamily: 'ui-sans-serif, -apple-system, system-ui, sans-serif'
    fontSize: '0.625rem'
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: '0.05em'
  mono:
    fontFamily: 'JetBrains Mono Variable, SF Mono, Fira Code, monospace'
    fontSize: '0.8125rem'
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 'normal'
rounded:
  sm: '6px'
  md: '8px'
  lg: '12px'
  xl: '16px'
  2xl: '20px'
  full: '9999px'
spacing:
  xs: '4px'
  sm: '8px'
  md: '16px'
  lg: '24px'
  xl: '32px'
components:
  button-primary:
    backgroundColor: '{colors.ink}'
    textColor: '{colors.paper}'
    rounded: '{rounded.md}'
    padding: '8px 16px'
  button-primary-hover:
    backgroundColor: '#000000'
    textColor: '{colors.paper}'
    rounded: '{rounded.md}'
    padding: '8px 16px'
  button-cta:
    backgroundColor: '{colors.terracotta}'
    textColor: '{colors.paper-white}'
    rounded: '{rounded.md}'
    padding: '14px 32px'
  button-cta-hover:
    backgroundColor: '{colors.terracotta-deep}'
    textColor: '{colors.paper-white}'
    rounded: '{rounded.md}'
    padding: '14px 32px'
  button-ghost:
    backgroundColor: 'transparent'
    textColor: '{colors.ink-secondary}'
    rounded: '{rounded.md}'
    padding: '8px 16px'
  input:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: '8px 12px'
  card:
    backgroundColor: '{colors.paper-white}'
    textColor: '{colors.ink}'
    rounded: '{rounded.lg}'
    padding: '16px'
  tag:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink-tertiary}'
    rounded: '{rounded.full}'
    padding: '2px 8px'
---

# Design System: Memry

## 1. Overview

**Creative North Star: "The Quiet Workshop"**

Memry is a well-made workbench where the noise stops. The system descends from a
single doctrine — **Warm Utility** — paper-inspired surfaces, serif-editorial
typography, flat-first depth, and motion that exists only to explain a change. Every
screen is a calm, private room: the user opens it for hours, often offline, and it
should never compete for attention with the work inside it. Warmth is structural,
carried by beige paper (#f6f5f0), near-black ink (#1a1a1a), and editorial serifs —
not by decoration.

The palette runs three theme bodies from one set of token names: **Warm** (default,
beige paper), **White** (Notion-clean, cooler neutrals), and **Dark** (neutral
charcoal #191919, muted warm text). Brand identity is carried by a single warm
accent — **terracotta #ff671a** — used sparingly and deliberately. Inside the app,
each user owns their own accent via a runtime `--tint` (default indigo #6366f1) for
selection, focus, and active states; terracotta remains the fixed brand color of the
product itself.

This system explicitly rejects three things, drawn straight from the product's
anti-references: **cold enterprise/corporate** (no navy-and-gray B2B, no stock-photo
trust badges — this is founder-made and personal), **playful/gamified consumer** (no
mascots, confetti, streaks, or achievement toasts — respect the user, don't reward
them), and **the cluttered productivity tool** (no feature-soup toolbars, no
everything-visible-at-once — every feature is a toggle and the default is quiet).

**Key Characteristics:**

- Paper-and-ink warmth; beige default surface, near-black text, editorial serifs.
- One brand accent (terracotta), used rarely; a per-user `--tint` for in-app accent.
- Flat-first: surfaces are flat at rest; shadow is a response to state, not decoration.
- Three coordinated themes (Warm / White / Dark) from one token vocabulary.
- Two-axis density (Comfortable / Compact) so the same UI serves calm and dense use.
- Motion is purposeful and short; reduced-motion is a first-class path, not a fallback.

## 2. Colors

A warm-neutral foundation with a single saturated brand accent and theme-aware semantic ramps.

### Primary

- **Terracotta** (#ff671a): The one signature brand accent. Marketing CTAs, the logo,
  hero emphasis, and brand moments. Inside the app it appears as the default sense of
  "Memry orange"; in-app interactive accent is delegated to `--tint`. Rare by rule.
- **Terracotta Deep** (#b33c00): Hover/pressed state for terracotta surfaces; the
  darker end of the brand ramp.

### Secondary

- **Sage** (#5b7f6a): A muted botanical green for quiet positive states — completed
  checkboxes (#7b9e87 in-app), "done" affirmations, calm success. Never neon.
- **Indigo Tint** (#6366f1): The _default_ value of the user-customizable `--tint`.
  Drives selection backgrounds, focus rings, and active nav inside the app. Treated
  as a variable, not a fixed brand color — the user may replace it.

### Neutral

- **Paper** (#f6f5f0): Default (Warm theme) page background — beige, calm, low-glare.
- **Paper White** (#ffffff): Card surfaces, and the entire canvas in the White theme.
- **Surface** (#efefe9): Panels, sidebar, secondary containers. **Surface Active**
  (#e4e4de) is the hover/selected layer above it.
- **Ink** (#1a1a1a): Primary text and the app's primary-button fill. **Ink Secondary**
  (#4a4a4a): body copy, sidebar items. **Ink Tertiary** (#8c8c8c): metadata, dates,
  icons — still AA on paper, never lighter.
- **Charcoal** (#191919): Dark-theme background; **Charcoal Surface** (#222222) panels;
  **Charcoal Ink** (#bcbab6) text. Matched to the desktop app so brand reads identical
  across marketing dark mode and the product.
- **Border** (#e4e4de): Default 1px dividers; use `/50` opacity for whisper dividers.

### Tertiary

- **Destructive** (#dc2626): Delete, irreversible actions, error text. The only red.
- **Category Dots** (cyan #06b6d4, purple #8b5cf6, green #22c55e, orange #f97316):
  Small category indicators only; brighter variants in dark mode. Never as fill.

### Named Rules

**The Rare Terracotta Rule.** The brand accent appears on ≤10% of any in-app screen.
Its scarcity is the signal; flood the UI with orange and it stops meaning "Memry".

**The Tint-Is-Borrowed Rule.** In-app accent (selection, focus, active) comes from
`--tint`, never a hardcoded hex. The user owns that color; respect it through
`color-mix()` derivations (`--tint-hover`, `--tint-light`, `--tint-ring`).

**The Gray-On-Paper Floor Rule.** Body text never goes lighter than Ink Tertiary
(#8c8c8c). Light gray "for elegance" on tinted paper is the readability failure this
system forbids.

## 3. Typography

**Display Font:** Playfair Display Variable (with Crimson Pro, Georgia fallback)
**Editorial Serif:** Crimson Pro Variable (with Georgia, Times fallback)
**Heading Sans:** Space Grotesk Variable (with system-ui fallback)
**Body Font:** native system sans (`ui-sans-serif, -apple-system, system-ui, …`)
**Mono Font:** JetBrains Mono Variable (with SF Mono, Fira Code)

**Character:** A deliberate serif/sans contrast pairing. Editorial serifs (Playfair,
Crimson Pro) carry titles and content — the "warm, made-by-a-person" voice — while a
fast native system sans handles dense UI labels, metadata, and body. Space Grotesk
adds a crisp geometric note to section headings and onboarding. No two similar sans
families are ever paired; contrast comes from the serif/sans axis.

> Note: the marketing site (`apps/landing`) runs a sibling pairing — Satoshi (sans)
> with Inter for headings and JetBrains Mono — on the same paper/charcoal palette.
> The brand DNA is shared; only the type families differ by surface.

### Hierarchy

- **Display** (Playfair, 500, clamp(2rem→3.5rem), lh 1.1, -0.02em): Dramatic headers,
  hero moments, empty-state statements. Rare and large.
- **Headline** (Space Grotesk, 600, 1.5rem, lh 1.2, -0.01em): Section headings,
  onboarding titles. The structural voice.
- **Title** (Crimson Pro, 500, 1.125rem, lh 1.2): Card titles, note/editorial content.
  The `.card-title` utility.
- **Body** (system sans, 400, 0.875rem, lh 1.5): Default UI and reading text. Cap
  reading measure at **65–75ch**.
- **Label** (system sans, 500, 0.625rem, uppercase, +0.05em): Tags, badges, the
  `.text-tag` utility. The only place uppercase tracking is allowed.
- **Mono** (JetBrains Mono, 400, 0.8125rem): Code, tokens, technical/keyboard text.

### Named Rules

**The Serif-For-Content Rule.** Anything the user _authored or reads_ (note titles,
card titles, journal) gets the serif. Anything that is _chrome_ (labels, counts,
toolbars) gets the system sans. Don't blur the two.

**The One-Heading-Sans Rule.** Space Grotesk is the only display-sans. Never introduce
a second geometric sans for "variety"; weight and size carry hierarchy.

## 4. Elevation

Flat-first. Surfaces are flat at rest and depth is a _response to state_, not an
ambient decoration. Light themes use barely-there shadows; the Dark theme uses heavier
values purely so layered surfaces stay legible against charcoal. Stacking order is a
semantic scale (dropdown → sticky → modal-backdrop → modal → toast → tooltip), never
arbitrary z-index values.

### Shadow Vocabulary

- **Card** (`0 1px 2px rgb(0 0 0/0.03), 0 1px 3px rgb(0 0 0/0.05)`): Resting cards and
  panels. Whisper-soft in light, ~0.3–0.4 alpha in Dark.
- **Card Hover** (`0 4px 6px -1px rgb(0 0 0/0.07), 0 2px 4px -2px rgb(0 0 0/0.05)`):
  Paired with `hover-lift` (translateY(-2px)) — the only time a card leaves the page.
- **Dropdown** (`0 4px 24px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)`): Popovers,
  menus, floating surfaces that must read as detached.

### Named Rules

**The Flat-By-Default Rule.** A surface at rest casts no shadow worth noticing. If a
card looks lifted before the user touches it, the shadow is wrong. Glassmorphism
(decorative blur/glass) is forbidden as a default; it appears rarely and purposefully
or not at all.

## 5. Components

### Buttons

- **Shape:** Gently rounded (8px, `rounded-md`); pills (`rounded-full`) only for
  tags/badges.
- **Primary (in-app):** Ink fill (#1a1a1a) on paper text (#f6f5f0) — quiet authority,
  not brand color. Padding 8–16px.
- **CTA (brand/marketing):** Terracotta fill (#ff671a) on white, hover → Terracotta
  Deep (#b33c00). Padding 14×32px. This is where the brand accent earns its keep.
- **Ghost / Secondary:** Transparent, Ink Secondary text, `surface-active` on hover.
- **Hover / Focus / Press:** `press-effect` scales to 0.98 on `:active`; focus shows a
  `--tint`-derived ring. Transitions use `--duration-instant`/`fast` with `--ease-out`.

### Chips / Tags

- **Style:** `surface` background, Ink Tertiary text, `rounded-full`, 10px uppercase
  label with +0.05em tracking (`.text-tag`).
- **State:** Entrance via `.tag-enter` (pop-in), exit via `.tag-exit`. Selected filter
  chips borrow `--tint-light` as background.

### Cards / Containers

- **Corner Style:** `rounded-lg` (12px) default; `rounded-xl` (16px) for large panels.
- **Background:** White card (#ffffff) on paper; charcoal-surface (#222222) in Dark.
  Semantic pastel tints (sage/rose/sand/lavender/grey) classify knowledge cards.
- **Shadow Strategy:** `shadow-card` at rest, `shadow-card-hover` + `hover-lift` on
  hover. See Elevation.
- **Border:** 1px `border` (#e4e4de), or none; never a colored side-stripe.
- **Internal Padding:** 16px comfortable; density-aware via `DENSITY_CONFIG`.

### Inputs / Fields

- **Style:** Transparent or surface fill, 1px `input` border (#e4e4de), `rounded-md`.
- **Focus:** Border shifts plus a `--tint-ring` (30% tint) ring — never a hard outline.
- **Placeholder:** Must hit 4.5:1 (use Ink Tertiary, not a faint gray).

### Navigation (Sidebar)

- **Style:** 240px fixed, `sidebar` surface (#efefe9 / #202020 dark), serif-free.
  Folder text #3d3a35, child text #5c5850; active item carries the `--tint`.
- **States:** Hover → `sidebar-accent` (rgba(0,0,0,0.05)); active → tint-tinted. Long
  labels fade via a conditional mask only when truly overflowing.

### Signature: Density System

Memry ships **Comfortable** and **Compact** densities (via `useDisplayDensity()`),
swapping padding, row height (48px ↔ 36px), icon size, and type scale across the whole
app. This is how one calm UI also serves power-dense workflows without a redesign.

## 6. Do's and Don'ts

### Do:

- **Do** default every screen to the Warm paper surface (#f6f5f0) with near-black ink
  (#1a1a1a); let calm be the resting state.
- **Do** keep terracotta (#ff671a) rare — brand moments and CTAs only, ≤10% of any
  in-app screen.
- **Do** route in-app accents through `--tint` and its `color-mix()` derivations, so
  the user's chosen color is respected everywhere.
- **Do** use the serif (Crimson Pro / Playfair) for authored and read content; the
  system sans for chrome.
- **Do** keep surfaces flat at rest; introduce shadow only on hover/focus/elevation.
- **Do** ship a `prefers-reduced-motion` path for every animation (durations → ~0,
  removals snap to opacity 0).
- **Do** use logical Tailwind properties (`ms-*`, `pe-*`, `start-*`) so all 32 locales
  flip cleanly in RTL.

### Don't:

- **Don't** make it read as a **cold enterprise/corporate** tool — no navy-and-gray
  B2B chrome, no stock-photo trust badges, no soulless density.
- **Don't** make it **playful or gamified** — no mascots, confetti, streaks, badges, or
  achievement toasts. Respect the user; don't reward them.
- **Don't** build a **cluttered productivity tool** — no feature-soup toolbars, no
  everything-visible-at-once. Every feature is a toggle; design for its absence.
- **Don't** use a `border-left`/`border-right` greater than 1px as a colored accent
  stripe on cards, list items, or callouts. Use full borders or background tints.
- **Don't** use gradient text (`background-clip: text`). Emphasis comes from weight,
  size, and the one solid terracotta — never a gradient.
- **Don't** use glassmorphism as a default decorative surface.
- **Don't** drop body text below Ink Tertiary (#8c8c8c) on paper, or below 4.5:1
  anywhere — light gray "for elegance" is forbidden.
- **Don't** flood the UI with terracotta; if a screen looks orange, the brand accent
  has stopped meaning anything.
