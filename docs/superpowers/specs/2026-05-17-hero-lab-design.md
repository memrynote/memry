# Hero Lab — design spec

**Date:** 2026-05-17
**Owner:** Kaan
**Status:** approved (proceed to plan)

## Problem

The Memry landing hero is text-only. Recently we admired the scroll effect on
[fora.so](https://fora.so/) where the page header reads as "floating behind" a
hero image while you scroll — the image extends to the top of the page and
passes under a fully-transparent fixed header. We want the same effect, but
before we commit to a single direction we want to compare four visual
treatments live, in the actual landing shell, and pick the winner.

## Goal

Ship four throwaway prototype routes (`/1`, `/2`, `/3`, `/4`) that each render
the real `Header` floating over a different hero treatment, with enough
real page content below the hero to test the scroll behavior end-to-end. Use
the prototypes to choose one, then delete the other three.

## Non-goals

- Not redesigning the hero copy. Keeps `Your thoughts, beautifully organized.`
  and the existing waitlist form.
- Not adding analytics, A/B routing, or feature flags. Picker is human, not data.
- Not building a "hero theme" abstraction. The 4 variants ship as siblings,
  not as configurable variants of a single component.
- Not changing any of the real routes (`/`, `/features/*`, `/pricing`, etc.).
  Default `Header` behavior is unchanged on every existing page.

## How the effect actually works

Confirmed by inspecting fora.so live: the header is `position: fixed; top: 0;
z-index: 7; background: transparent`. Nothing on the page has a higher
z-index. The hero visual sits in normal document flow at `y=0`, and content
scrolls under the transparent header. The user perceives "header behind
image" because the bar itself has zero fill — header text/logo paint on top,
but the bar is invisible.

The technique to port is therefore: (a) hero visual must touch `y=0`,
(b) `Header` must render with no background while the hero is on screen,
(c) once the hero scrolls past, `Header` regains its existing glass-pill
treatment so the rest of the page reads normally.

## Variants

All four routes share the same shell: real `<Header transparent>` + variant
hero + `<FeatureFlow />` + `<Pricing />` + real `<Footer />`. The shell is
named `LabFrame`. Below-hero sections exist so the scroll transition is
testable; they are not redesigned.

### /1 — Photo bedrock + product mockup overlay

Closest to fora.so. A wide ambient photo fills the hero, a Memry mockup
floats in front, hero copy + waitlist sit between the two layers.

- Background: single `<img>` (or `<picture>`) sourced from a warm-toned
  Unsplash landscape, sized `w-screen h-[100vh]` from `y=0`, `object-cover`,
  `z-0`. URL is a constant in `hero-lab/assets.ts` so it can be swapped
  without code changes.
- Mockup: `<MockupFrame>` (existing) wrapping `/screenshots/inbox.png`,
  positioned in the lower-half of the hero, `z-20`, with a soft drop shadow.
- Hero copy + waitlist: centered, `z-10`, white text with a faint dark
  vignette on the image so text reads against any photo region.
- Gradient mask at the bottom of the image fades into `bg-paper` so the
  transition into `FeatureFlow` is not a hard line.

### /2 — Lifted DemoShowcase

The existing `<DemoShowcase>` (animated inbox/journal/notes/tasks scenes
inside `MockupFrame`) is promoted into the hero zone, sitting flush to the
top so the header floats over its top edge.

- Background: a soft `bg-paper-alt` gradient. No photo.
- Hero copy + waitlist: rendered above the showcase, no z-index trick needed.
- The showcase itself extends from roughly `y=64` (giving Header room) and
  contains motion that catches the eye during scroll.

### /3 — Ambient gradient / aurora

No image, no mockup. Tall full-bleed gradient backdrop behind the existing
text-centric hero so the Header floats over color rather than over a photo.
Cheapest path; tests whether the effect carries without imagery.

- Background: `AuroraBackdrop` component — stacked radial gradients +
  one blurred SVG noise layer + a slow `motion` opacity loop. All CSS.
- Hero copy + waitlist: unchanged from current `Hero.tsx`, just placed
  on top of the aurora.

### /4 — Full-bleed product screenshot, no overlay text

Single huge screenshot occupies the hero zone (no text overlay on the
image). Heading + form are pushed below the image. Header rides over the
screenshot.

- Background: `<img src="/screenshots/notes.png">` styled `w-screen
  h-[78vh] object-cover object-top`, `z-0`.
- Hero copy + waitlist: rendered in a normal-flow block below the
  screenshot, centered, on `bg-paper`.

## Header transparency mechanism

Add to existing `Header` (`apps/landing/src/components/layout/Header.tsx`):

1. `transparent?: boolean` prop. Default `false` — every current usage is
   unaffected.
2. When `transparent === true`, swap the pill classes:
   - Default: `bg-paper/60 backdrop-blur-2xl border-white/70 shadow-[...]`
   - Transparent: `bg-transparent backdrop-blur-0 border-transparent shadow-none`
3. While `transparent` is active, the header gets `data-on-image="true"`.
   A small CSS rule overrides nav link / dropdown trigger / GitHub star
   widget / theme toggle colors to white so they read against a photo.
   (Scoped via `[data-on-image="true"]` selectors in the same file or a
   sibling CSS module.) The GitHub star widget and theme toggle keep
   their pill silhouette but go translucent-white instead of paper-tinted.
4. Scroll restoration: the `LabFrame` renders a 1px sentinel
   `<div data-hero-end>` at the bottom of the hero. `Header` (when
   `transparent` is true) attaches an `IntersectionObserver` to that
   sentinel via `document.querySelector('[data-hero-end]')` after mount.
   When the sentinel goes above the viewport top, `Header` flips its
   internal state to the default glass pill. When it returns below the
   viewport, it goes transparent again. Observer is torn down on unmount.
5. Real pages do not pass `transparent` and never run the observer.

Tradeoff considered: a context-based approach was rejected because four
throwaway routes don't justify a new context. A `transparent` prop +
sentinel is local, easy to delete with the lab routes when we pick a
winner.

## File layout (new)

```
apps/landing/src/
├─ pages/HeroLab/
│  ├─ LabFrame.tsx        # shared shell: Header transparent + slot + lower
│  │                       sections + sentinel + switcher
│  ├─ Variant1.tsx        # photo + mockup
│  ├─ Variant2.tsx        # demo showcase
│  ├─ Variant3.tsx        # aurora
│  ├─ Variant4.tsx        # big screenshot
│  └─ index.ts            # barrel for App.tsx route imports
└─ components/hero-lab/
   ├─ AmbientPhoto.tsx    # variant 1 bg layer
   ├─ AuroraBackdrop.tsx  # variant 3 bg layer
   ├─ HeroLabSwitcher.tsx # floating 1·2·3·4 pill bottom-right
   └─ assets.ts           # ambient photo URL, mockup screenshot path,
                          # full-bleed screenshot path
```

## Routing

`apps/landing/src/App.tsx` adds:

```tsx
<Route path="/1" element={<Variant1 />} />
<Route path="/2" element={<Variant2 />} />
<Route path="/3" element={<Variant3 />} />
<Route path="/4" element={<Variant4 />} />
```

Each variant page wraps `<LabFrame variant={N}>{...hero...}</LabFrame>`.

Each variant page adds `<Helmet><meta name="robots" content="noindex" /></Helmet>`
so the prototype URLs do not get crawled.

## Switcher

`HeroLabSwitcher` is a small fixed pill, bottom-right, `z-[60]`. Four `Link`s
labeled `1 2 3 4` with the active one highlighted in terracotta. Includes a
fifth tiny `Link to="/"` labeled `←` for returning to the real site. Rendered
inside `LabFrame` so all four variants get it for free.

## Assets

- **Variant 1 photo**: Unsplash hot-link, defined as
  `AMBIENT_PHOTO_URL` in `assets.ts`. Initial pick: a warm dusk
  landscape (e.g. `https://images.unsplash.com/photo-1505144808419-1957a94ca61e?auto=format&fit=crop&w=2400&q=80`).
  Swappable in one line. If quality is judged on this prototype, we replace
  the URL with a curated CDN-hosted asset.
- **Variant 1 mockup**: existing `/screenshots/inbox.png` inside the
  existing `MockupFrame` component.
- **Variant 2**: no new assets — uses existing `DemoShowcase`.
- **Variant 3**: no assets — pure CSS gradients in `AuroraBackdrop`.
- **Variant 4**: existing `/screenshots/notes.png` (largest of the
  current screenshots).

## Below-hero content

Each `LabFrame` renders, in order, after the hero slot:

1. `<FeatureFlow />` (existing section, shows the feature loop)
2. `<Pricing />` (existing section, smaller scroll target)
3. `<Footer />` (existing)

This is enough surface to scroll past the hero and watch the Header swap
back to its glass pill state. It also catches any visual jank at the
hero→content seam.

## Theme + dark mode

Theme toggle in Header is unchanged. Variants 1 + 4 use fixed photos so
they look the same in light and dark mode. Variants 2 + 3 respect the
theme. Acceptable for a prototype.

## Mobile

All four variants must render responsively (no horizontal scroll, hero
copy readable). The header pill stays a hamburger on mobile as today.
Mobile is a sanity check, not the primary evaluation surface — we judge
the effect on desktop.

## Risks + mitigations

1. **Header transparent + light photo region → unreadable nav text.**
   Mitigation: every photo-backed variant (1, 4) adds a subtle dark
   gradient on the top 96px of the hero (`from-black/40 to-transparent`)
   so nav text always has contrast. Documented as part of variants 1 + 4.
2. **IntersectionObserver sentinel missing on first render.**
   Mitigation: `Header` re-queries the sentinel in a `useEffect`, retries
   once on next frame if not found. If still missing (real pages), no-op.
3. **Mockup positioning on small screens.**
   Mitigation: variant 1 mockup uses `hidden md:block` for the floating
   mockup; on mobile only the photo + text show.
4. **Bundle bloat from 4 unused variants in production.**
   Mitigation: lazy-load each variant via `React.lazy` so they only ship
   when someone hits `/1` etc.

## Out of scope (explicit)

- No new copy for the hero
- No new analytics
- No A/B framework
- No new icon set
- No changes to `Footer`, `Header` dropdown contents, `FeatureFlow`,
  `Pricing`, or any other shared section
- No SEO work (lab routes are `noindex`)

## Success criteria

1. Visiting `/1`, `/2`, `/3`, `/4` each renders a distinct hero with the
   real `Header` floating transparently over it.
2. Scrolling past the hero on any of the four routes flips `Header` back
   to its glass-pill treatment, smoothly (CSS transition).
3. Scrolling back to the top flips it back to transparent.
4. Visiting `/` and any existing route is visually unchanged from `main`.
5. `pnpm --filter @memry/landing build` succeeds.
6. `HeroLabSwitcher` can hop between all four routes and `/` in one click.

## Decommission plan

Once a winning variant is chosen:

1. Promote the chosen variant's hero into `Hero.tsx` (or a new sibling),
   replacing the current text-only hero.
2. Keep the `Header transparent` prop + sentinel mechanism if the winner
   uses it; otherwise remove both.
3. Delete `pages/HeroLab/`, `components/hero-lab/`, and the four route
   entries.
4. Single commit, single PR.
