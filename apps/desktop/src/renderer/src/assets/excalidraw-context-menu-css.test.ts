import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The renderer suite runs in jsdom, where `import.meta.url` is not a file: URL.
// Vitest's cwd is apps/desktop.
const BASE_CSS = join(process.cwd(), 'src/renderer/src/assets/base.css')
const PACKAGE_JSON = join(process.cwd(), 'package.json')

const OVERRIDE_SELECTOR = '.excalidraw .context-menu'

/**
 * Excalidraw's canvas context menu ships with no height bound and no overflow,
 * inside a container that is `overflow: hidden` — so a menu taller than the
 * space below the click point is silently truncated with no scrollbar. Our fix
 * is a scoped CSS override in base.css (see the docblock there). jsdom has no
 * layout and no cascade, and the rule belongs to a third-party component we
 * never render in unit tests, so a source-level parse-and-assert is the only
 * honest guard: it catches the override being deleted, renamed, or stripped of
 * either half (the cap or the scroll).
 */
function stripComments(css: string): string {
  return (
    css
      // Statement at-rules go first, and before comments: `@source
      // "…/streamdown/dist/*.js";` contains a literal `/*`, so stripping
      // comments straight away reads it as a comment opener and swallows every
      // line up to the next `*/` — about sixty of them.
      .replace(/^[ \t]*@[a-z-]+[^;{}\n]*;[ \t]*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
  )
}

/** Body of the last rule whose selector list contains `selector`, or null. */
function ruleBody(css: string, selector: string): string | null {
  let found: string | null = null
  for (const [, selectorList, body] of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = selectorList.split(',').map((part) => part.trim().replace(/\s+/g, ' '))
    if (selectors.includes(selector)) found = body
  }
  return found
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of body.split(';')) {
    const colon = part.indexOf(':')
    if (colon === -1) continue
    out.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim())
  }
  return out
}

/** The comment block immediately preceding the override rule. */
function docblockAbove(css: string, selector: string): string {
  const ruleStart = css.indexOf(`${selector} {`)
  if (ruleStart === -1) return ''
  const before = css.slice(0, ruleStart)
  const open = before.lastIndexOf('/*')
  const close = before.lastIndexOf('*/')
  if (open === -1 || close < open) return ''
  return before.slice(open, close + 2)
}

describe('excalidraw context-menu override in base.css', () => {
  const css = readFileSync(BASE_CSS, 'utf8')

  it('declares a bounded, scrollable canvas context menu', () => {
    const body = ruleBody(css, OVERRIDE_SELECTOR)
    expect(body, `no \`${OVERRIDE_SELECTOR}\` rule in base.css`).not.toBeNull()

    const decls = declarations(body as string)

    // The cap: without it the menu can grow past the canvas container, which is
    // `overflow: hidden`, and the overflowing items become unreachable.
    const maxHeight = decls.get('max-height')
    expect(maxHeight, 'override must cap the menu height').toBeDefined()
    expect(maxHeight).not.toBe('none')

    // The scroll: a capped menu with no scroll path just truncates differently.
    expect(['auto', 'scroll']).toContain(decls.get('overflow-y'))

    // A vertical scrollbar in a shrink-to-fit box must not induce a horizontal
    // one; items are `white-space: nowrap` upstream, so there is nothing to lose.
    expect(decls.get('overflow-x')).toBe('hidden')
  })

  it('pins the Excalidraw version it was verified against', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    // Bundled into the renderer by electron-vite, so it lives in devDependencies.
    const installed =
      pkg.dependencies?.['@excalidraw/excalidraw'] ??
      pkg.devDependencies?.['@excalidraw/excalidraw']
    expect(installed, '@excalidraw/excalidraw is no longer a desktop dependency').toBeDefined()

    // Failing here on an upgrade is the point: the override compensates for an
    // upstream bug, so a new version must be rechecked before the pin moves.
    expect(docblockAbove(css, OVERRIDE_SELECTOR)).toContain(installed as string)
  })
})
