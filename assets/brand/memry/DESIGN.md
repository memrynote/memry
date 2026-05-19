---
version: alpha
name: 'memry'
colors:
  primary: '#FF671A'
  dark: '#1F2937'
  white: '#FFFFFF'
  color-800: '#4D1A00'
  color-700: '#802B00'
  color-600: '#B33C00'
  color-500: '#E64D00'
  color-400: '#FF671A'
  color-300: '#FF894D'
  color-200: '#FFAA80'
  color-100: '#FFCCB3'
components:
  button-primary:
    backgroundColor: '{colors.color-600}'
    textColor: '{colors.white}'
  button-primary-hover:
    backgroundColor: '{colors.color-700}'
    textColor: '{colors.white}'
  button-secondary:
    backgroundColor: '{colors.white}'
    textColor: '{colors.color-600}'
  button-secondary-hover:
    backgroundColor: '{colors.white}'
    textColor: '{colors.color-700}'
---

## Overview

Brand kit and design tokens for **memry**. This file lives at `assets/brand/memry`
with the reusable source assets for product UI, desktop packaging, social profiles,
marketing surfaces, and docs.

## Brand Kit Files

Pick the right asset for the context instead of regenerating logos.

### Master logo

| File             | What it is                        | When to use                                                      |
| ---------------- | --------------------------------- | ---------------------------------------------------------------- |
| `logo.svg`       | Primary logo, vector, transparent | Default. Any target that supports SVG (web, Figma, modern docs). |
| `logo.png`       | Primary logo, raster, transparent | Raster contexts on light / white backgrounds.                    |
| `logo-white.png` | White logo, raster, transparent   | Dark backgrounds, photos, or any low-contrast surface.           |

### Icon only

| File             | What it is                       | When to use                                                      |
| ---------------- | -------------------------------- | ---------------------------------------------------------------- |
| `icon-color.png` | Icon in brand color, transparent | Source mark for generated app icons, square slots, inline marks. |
| `icon-white.png` | Icon in white, transparent       | Dark or photo backgrounds, mark only.                            |

### Desktop app icon

The desktop app icon is generated from `assets/brand/memry/icon-color.png` by
`apps/desktop/scripts/generate-icons.mjs`. The generator wraps the transparent
brand mark in a rounded macOS-style tile, adds a warm off-white background by
default, and applies subtle depth to the mark with highlight, shade, and shadow
overlays. Pass `--dark` to write flat-black dark-background Electron app icons instead.

Generated outputs:

- `apps/desktop/build/icon.png` — runtime window / Dock icon source.
- `apps/desktop/build/icon.icns` — macOS packaged app icon.
- `apps/desktop/build/icon.ico` — Windows packaged app icon.
- `assets/brand/memry/social/profile-image.png` — square Twitter/X and Reddit profile image.
- `assets/brand/memry/social/profile-square.png` — explicit square Twitter/X and Reddit profile image.
- `assets/brand/memry/social/profile-rectangle.png` — rectangular Twitter/X and Reddit profile banner image.
- `assets/brand/memry/social/profile-image-dark.png` — dark-theme square profile image.
- `assets/brand/memry/social/profile-square-dark.png` — dark-theme explicit square profile image.
- `assets/brand/memry/social/profile-rectangle-dark.png` — dark-theme rectangular profile banner image.

Regenerate after changing `icon-color.png`:

```bash
pnpm --dir apps/desktop generate:icons
pnpm --dir apps/desktop generate:icons --dark
```

### Platform-ready

| File                                | What it is                                    | When to use                                                 |
| ----------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| `favicon.ico`                       | ICO favicon                                   | Drop into website root as `/favicon.ico`.                   |
| `social-icon.png`                   | Icon on white background                      | Profile picture when a light avatar reads best.             |
| `inverse-avatar.png`                | Icon on brand-color background                | Profile picture when a colored avatar reads best.           |
| `social/profile-image.png`          | Square image with depth mark                  | Generated profile image for Twitter/X and Reddit.           |
| `social/profile-square.png`         | Square image with depth mark                  | Explicit square PNG for Twitter/X and Reddit profiles.      |
| `social/profile-rectangle.png`      | Rectangular image with depth mark             | Generated profile banner for Twitter/X and Reddit.          |
| `social/profile-image-dark.png`     | Dark square image with orange depth mark      | Dark-theme profile image for Twitter/X and Reddit.          |
| `social/profile-square-dark.png`    | Dark square image with orange depth mark      | Explicit dark square PNG for Twitter/X and Reddit profiles. |
| `social/profile-rectangle-dark.png` | Dark rectangular image with orange depth mark | Dark-theme profile banner for Twitter/X and Reddit.         |

### Social assets

- Use `social-icon.png` for light profile/avatar slots.
- Use `inverse-avatar.png` when a colored avatar reads better.
- Use `social/profile-image.png` for Twitter/X and Reddit profile images; it keeps the depth-treated mark on a full square background so profile platforms can crop it themselves.
- Use `social/profile-square.png` when you need the explicit square PNG name.
- Use `social/profile-rectangle.png` for Twitter/X and Reddit profile banners; it keeps the same depth-treated mark in a 1500x500 PNG.
- Use `social/profile-image-dark.png`, `social/profile-square-dark.png`, and `social/profile-rectangle-dark.png` when the profile or cover placement needs the dark-theme background with the orange depth-treated mark.
- Use `social/og-image.svg` as the source for the 1200x630 social preview.
- Copy the generated `social/og-image.png` to `apps/landing/public/og-image.png` so both
  `og:image` and `twitter:image` resolve to the current brand preview.
- Keep new channel-specific banners under `assets/brand/memry/social/` so they stay with the brand kit.

## Colors

### Primary tokens

- **primary** (`#FF671A`) — Primary brand color. CTAs, active states, highlights, key brand moments.
- **dark** (`#1F2937`) — Body text, borders, elements that need maximum readability.
- **white** (`#FFFFFF`) — Backgrounds, negative space, clean minimal layouts.

### Extended palette (generated shades)

- **color-800** (`#4D1A00`) — Darkest shade. Emphatic text on light.
- **color-700** (`#802B00`) — Active / pressed states, emphasis.
- **color-600** (`#B33C00`) — Hover state for primary CTAs.
- **color-500** (`#E64D00`) — Mid tone. Generic accents and fills.
- **color-400** (`#FF671A`) — Secondary accents. _(matches `primary` — the brand color)_
- **color-300** (`#FF894D`) — Disabled states, muted accents.
- **color-200** (`#FFAA80`) — Hover on light surfaces, dividers.
- **color-100** (`#FFCCB3`) — Lightest tint. Page backgrounds, subtle surfaces.

### Status badges

Any pairing of two colors from {primary, `color-100`–`color-700`, `#1F2937`, `#FFFFFF`} that reaches a 6:1 contrast ratio works as a badge. Typical pairs:

- Dark pill: background `#1F2937` or `color-800`, text `#FFFFFF` or a light palette tint.
- Tinted pill: background `color-100` / `color-200`, text `color-700` / `color-800`.
- Brand pill: background `primary` (`#FF671A`), text `#FFFFFF`. Only if the pair passes 6:1.

### Contrast note

Check WCAG AA contrast (4.5:1) before you ship. Anymark does not certify specific combinations.

## Components

Buttons are defined as tokens in the frontmatter above (`button-primary`, `button-primary-hover`, `button-secondary`, `button-secondary-hover`). Only `backgroundColor` and `textColor` are specified. Padding, radius, and typography are intentionally left to the consumer's design system.

We pick shades that hit WCAG AA contrast (4.5:1) against their paired text or background color. Verify before use. If the raw `primary` color does not pass 4.5:1 against white, the tokens reference a darker palette shade (`color-600`, `color-700`, or `color-800`) instead.

## Do's and Don'ts

### Do

- Use `logo.svg` whenever the target supports vector. Fall back to PNG if any issues with SVG are found or if the customer requests it.
- Use `logo-white.png` on dark or photo backgrounds.
- Use lowercase `memry` in logo lockups where the icon appears next to the name.
- Use `pnpm --dir apps/desktop generate:icons` for desktop app icons instead of using `icon-color.png` raw in the Dock or packaged app.
- Keep clear space around the logo equal to at least the height of the icon.
- Reserve the `primary` color for primary CTAs, active states, and brand moments. Primary tokens (`primary`, `dark`, `white`) should cover ~80% of surfaces.
- Verify contrast when combining any two tokens from the extended palette.

### Don't

- Don't rotate the logo.
- Don't stretch, squash, or distort the proportions.
- Don't add gradients, shadows, outlines, or strokes to the master logo assets.
- Don't use the transparent `icon-color.png` directly as a desktop app icon; it needs the generated rounded tile treatment.
- Don't recolor the logo outside this palette.
- Don't place the logo on low-contrast or visually cluttered backgrounds.
- Don't swap horizontal for vertical layout, or remove the icon.
- Don't use the primary color decoratively. Treat it as a functional accent.
