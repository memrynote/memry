/**
 * WCAG contrast helpers for renderer tests.
 *
 * jsdom has no cascade and no layout, so a render can never prove a contrast
 * ratio. The palette is literal hex in base.css though, so tests read the theme
 * blocks straight from source and do the arithmetic themselves.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** WCAG AA floor for small text (under 18.66px, or 14px bold). */
export const AA_SMALL_TEXT = 4.5

/** Selector of every theme block that carries a full palette. */
export const THEMES = [':root', '.white', '.dark'] as const
export type ThemeSelector = (typeof THEMES)[number]

// Vitest's cwd is apps/desktop.
const BASE_CSS = join(process.cwd(), 'src/renderer/src/assets/base.css')

/**
 * One custom-property map per theme. base.css declares each theme across
 * several flat blocks (`@layer base` for the app palette, a later top-level
 * block for the sidebar palette), so declarations are merged in document order
 * — last wins, as the cascade would have it. `.white` and `.dark` are classes on
 * the root element, so `:root` still applies underneath them and seeds both.
 */
function readPalettes(): Map<ThemeSelector, Map<string, string>> {
  // Statement at-rules go first, and before comments: `@source
  // "…/streamdown/dist/*.js";` contains a literal `/*`, so stripping comments
  // straight away reads it as a comment opener and swallows every line up to
  // the next `*/` — about sixty of them, palette blocks included.
  const css = readFileSync(BASE_CSS, 'utf8')
    .replace(/^[ \t]*@[a-z-]+[^;{}\n]*;[ \t]*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const palettes = new Map<ThemeSelector, Map<string, string>>(
    THEMES.map((selector) => [selector, new Map<string, string>()])
  )

  for (const [, rawSelector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rawSelector.trim() as ThemeSelector
    const palette = palettes.get(selector)
    if (!palette) continue
    for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      palette.set(name, value.trim())
    }
  }

  const root = palettes.get(':root') as Map<string, string>
  for (const selector of THEMES) {
    if (selector === ':root') continue
    palettes.set(selector, new Map([...root, ...(palettes.get(selector) as Map<string, string>)]))
  }

  return palettes
}

const PALETTES = readPalettes()

/** Resolve a custom property to a hex literal, following `var(--x)` chains. */
export function resolveColor(selector: ThemeSelector, name: string): string {
  const palette = PALETTES.get(selector) as Map<string, string>
  let value = palette.get(name)
  for (let hops = 0; value?.startsWith('var(') && hops < 4; hops++) {
    value = palette.get(value.slice(4, -1).split(',')[0].trim())
  }
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(
      `${selector} ${name} does not resolve to a hex colour (got ${value ?? 'nothing'})`
    )
  }
  return value
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

// `text-*` utilities that set something other than a colour, so no ratio
// applies: sizes (`text-[11px]`, `text-xs`), alignment and wrapping. An
// arbitrary value that is not a length — `text-[#6b6459]` — is still a colour.
const NON_COLOR_TEXT =
  /^text-(\[\d|(xs|sm|base|lg|[2-9]?xl|start|end|left|right|center|justify|balance|pretty|wrap|nowrap|clip|ellipsis)$)/

function isColorTextUtility(utility: string): boolean {
  return utility.startsWith('text-') && !NON_COLOR_TEXT.test(utility)
}

/**
 * Every class in `className` that repaints the text behind a state variant,
 * however the variant is spelled. Plain `hover:text-…` is only one shape:
 * `group-hover/section:text-…`, `peer-hover:text-…`, `dark:hover:text-…` and
 * `[&:hover]:text-…` all repaint on hover too, and a guard that only matched
 * the first shape would wave every other one through.
 */
export function stateTextClasses(className: string): string[] {
  return className.split(/\s+/).filter((cls) => {
    const lastColon = cls.lastIndexOf(':')
    if (lastColon === -1) return false
    if (!isColorTextUtility(cls.slice(lastColon + 1))) return false
    return cls
      .slice(0, lastColon)
      .split(':')
      .some((variant) => /hover|focus|active/.test(variant))
  })
}

/** The unconditional text colour class, if the element sets one. */
export function restingTextClass(className: string): string | null {
  return (
    className
      .split(/\s+/)
      .filter((cls) => !cls.includes(':') && isColorTextUtility(cls))
      .at(-1) ?? null
  )
}

/** Composite `foreground` at `alpha` over `background`, both `#rrggbb`. */
function blend(foreground: string, background: string, alpha: number): string {
  const channel = (offset: number): string => {
    const f = parseInt(foreground.slice(offset, offset + 2), 16)
    const b = parseInt(background.slice(offset, offset + 2), 16)
    return Math.round(f * alpha + b * (1 - alpha))
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

/**
 * Hex a `text-…` utility actually paints: a literal `text-[#rrggbb]`, else a
 * theme token, composited over `background` when the class carries Tailwind's
 * `/NN` opacity modifier (`text-sidebar-muted/60` is not `--sidebar-muted`).
 */
export function textUtilityColor(selector: ThemeSelector, cls: string, background: string): string {
  const [token, alpha] = cls
    .slice(cls.lastIndexOf(':') + 1)
    .replace(/^text-/, '')
    .split('/')
  const literal = /^\[(#[0-9a-f]{6})\]$/i.exec(token)
  const hex = literal ? literal[1] : resolveColor(selector, `--${token}`)
  return alpha === undefined ? hex : blend(hex, background, Number(alpha) / 100)
}

/**
 * Assert that `className` clears AA for small text on every one of
 * `backgroundTokens`, in every theme, both at rest and under any state variant
 * — and that no state variant *lowers* the ratio it rests at. Throws naming the
 * class, theme and background that failed.
 */
export function assertSmallTextContrast(className: string, backgroundTokens: string[]): void {
  const resting = restingTextClass(className)
  if (!resting) throw new Error(`no resting text colour class in "${className}"`)

  for (const selector of THEMES) {
    for (const backgroundToken of backgroundTokens) {
      const background = resolveColor(selector, backgroundToken)
      const restingRatio = contrastRatio(
        textUtilityColor(selector, resting, background),
        background
      )
      if (restingRatio < AA_SMALL_TEXT) {
        throw new Error(
          `${resting} on ${backgroundToken} in ${selector} is ${restingRatio.toFixed(3)}:1, under AA ${AA_SMALL_TEXT}:1`
        )
      }

      for (const stateClass of stateTextClasses(className)) {
        const stateRatio = contrastRatio(
          textUtilityColor(selector, stateClass, background),
          background
        )
        if (stateRatio < AA_SMALL_TEXT) {
          throw new Error(
            `${stateClass} on ${backgroundToken} in ${selector} is ${stateRatio.toFixed(3)}:1, under AA ${AA_SMALL_TEXT}:1`
          )
        }
        if (stateRatio < restingRatio) {
          throw new Error(
            `${stateClass} on ${backgroundToken} in ${selector} drops contrast from ${restingRatio.toFixed(3)}:1 to ${stateRatio.toFixed(3)}:1`
          )
        }
      }
    }
  }
}
