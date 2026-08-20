import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The renderer suite runs in jsdom, where `import.meta.url` is not a file: URL.
// Vitest's cwd is apps/desktop.
const BASE_CSS = join(process.cwd(), 'src/renderer/src/assets/base.css')

const HANDLE = '.bn-container .bn-table-handle'
const ICON = `${HANDLE} [data-test='tableHandle']`
const HOVER_STATES = [':hover', ':focus-visible', "[data-state='open']"]

/**
 * BlockNote's table row/column handle is the 6-dot drag button at a row's
 * inline-start edge and a column's top edge. Neither @blocknote/core nor
 * @blocknote/shadcn styles `.bn-table-handle`, so at rest it is the full icon
 * button and reads as the loudest thing on a table. base.css re-cuts it as a
 * slim pill that expands back into the icon button on hover (see the docblock
 * there).
 *
 * jsdom has no cascade and no layout, and BlockNote's stylesheet is never
 * loaded in unit tests, so a source-level parse-and-assert is the honest guard
 * here: it catches the override being deleted, renamed, or stripped of either
 * stage. The rendered geometry is pinned separately by
 * tests/e2e/table-handle-pill.e2e.ts.
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

const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ')

/**
 * `css` with every at-rule block (`@media`, `@layer`, `@keyframes`, …) cut out.
 *
 * The overrides under test are top-level, and the reduced-motion guard restates
 * the same selectors with `transition: none`. Without this the flat rule scan
 * below would find that nested copy too and merge its `none` over the real
 * transition, so the transition assertion would pass on a stylesheet that had
 * lost its transition entirely.
 */
function topLevelRules(css: string): string {
  const flat = stripComments(css)
  let out = ''
  let cursor = 0
  let copied = 0
  while (cursor < flat.length) {
    if (flat[cursor] !== '@') {
      cursor++
      continue
    }
    out += flat.slice(copied, cursor)
    let scan = cursor
    while (scan < flat.length && flat[scan] !== '{' && flat[scan] !== ';') scan++
    if (flat[scan] === '{') {
      let depth = 1
      scan++
      while (scan < flat.length && depth > 0) {
        if (flat[scan] === '{') depth++
        else if (flat[scan] === '}') depth--
        scan++
      }
    } else {
      scan++
    }
    cursor = scan
    copied = scan
  }
  return out + flat.slice(copied)
}

/** Bodies of every top-level rule whose selector list contains `selector`. */
function ruleBodies(css: string, selector: string): string[] {
  const found: string[] = []
  for (const [, selectorList, body] of topLevelRules(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectorList.split(',').map(normalize).includes(normalize(selector))) found.push(body)
  }
  return found
}

/** Every declaration `selector` makes, merged across its rules (last wins). */
function declarations(css: string, selector: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const body of ruleBodies(css, selector)) {
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      out.set(normalize(part.slice(0, colon)), normalize(part.slice(colon + 1)))
    }
  }
  return out
}

/**
 * The reduced-motion block's contents. Nested at-rules survive `stripComments`
 * but not the flat rule regex above, so this slices the block out by brace
 * depth from the `@media (prefers-reduced-motion: reduce)` that mentions the
 * handle.
 */
function reducedMotionBlock(css: string): string | null {
  const flat = stripComments(css)
  const pattern = /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g
  for (const match of flat.matchAll(pattern)) {
    const start = (match.index as number) + match[0].length
    let depth = 1
    let cursor = start
    while (cursor < flat.length && depth > 0) {
      if (flat[cursor] === '{') depth++
      else if (flat[cursor] === '}') depth--
      cursor++
    }
    const block = flat.slice(start, cursor - 1)
    if (block.includes('.bn-table-handle')) return block
  }
  return null
}

describe('BlockNote table handle pill in base.css', () => {
  const css = readFileSync(BASE_CSS, 'utf8')

  it('rests as a slim pill rather than an icon button', () => {
    const rest = declarations(css, HANDLE)
    expect(rest.size, `no \`${HANDLE}\` rule in base.css`).toBeGreaterThan(0)

    // The pill proper. A row handle is 6x18; the column handle is the same box
    // under BlockNote's inline `rotate(0.25turn)`, so it renders 18x6.
    expect(rest.get('width')).toBe('6px')
    expect(rest.get('height')).toBe('18px')
    expect(rest.get('border-radius')).toBe('4px')

    // content-box, deliberately: `.bn-root *` inherits border-box, under which
    // the 2px ring would eat 4 of the 6px and leave a 2px hairline.
    expect(rest.get('box-sizing')).toBe('content-box')
  })

  it('paints the pill from theme tokens, not literals', () => {
    const rest = declarations(css, HANDLE)

    // Both must be tokens: the pill has to re-theme with paper/white/dark, and
    // the ring is only a knockout if it is exactly the editor background.
    expect(rest.get('background-color')).toBe('var(--text-tertiary)')
    expect(rest.get('border')).toBe('2px solid var(--background)')
  })

  it('hides the drag icon at rest', () => {
    const icon = declarations(css, ICON)
    expect(icon.size, `no \`${ICON}\` rule in base.css`).toBeGreaterThan(0)
    expect(icon.get('opacity')).toBe('0')

    // Faded, not `display: none` — it has to be able to fade back in, and the
    // pill clips it so the invisible icon cannot take hover events off-pill.
    expect(declarations(css, HANDLE).get('overflow')).toBe('hidden')
  })

  it.each(HOVER_STATES)('expands back into the icon button on %s', (state) => {
    const expanded = declarations(css, `${HANDLE}${state}`)
    expect(expanded.size, `\`${HANDLE}${state}\` is not styled`).toBeGreaterThan(0)

    const rest = declarations(css, HANDLE)
    expect(expanded.get('width')).not.toBe(rest.get('width'))
    expect(expanded.get('height')).not.toBe(rest.get('height'))
    expect(parseFloat(expanded.get('width') as string)).toBeGreaterThan(
      parseFloat(rest.get('width') as string)
    )
    expect(parseFloat(expanded.get('height') as string)).toBeGreaterThan(
      parseFloat(rest.get('height') as string)
    )

    // The ring is what makes it read as a pill; it goes when the pill does.
    expect(expanded.get('border-color')).toBe('transparent')
  })

  it.each(HOVER_STATES)('shows the drag icon again on %s', (state) => {
    const shown = declarations(css, `${HANDLE}${state} [data-test='tableHandle']`)
    expect(shown.size, `the icon is never revealed on ${state}`).toBeGreaterThan(0)
    expect(shown.get('opacity')).toBe('1')
  })

  it('transitions the two stages instead of cutting between them', () => {
    // The bundled shadcn Button ships `transition-all`; an explicit list is
    // what keeps the swap off every other animatable property.
    const transition = declarations(css, HANDLE).get('transition') ?? ''
    expect(transition).not.toBe('')
    expect(transition).not.toContain('all')
    for (const property of ['width', 'height', 'background-color', 'border-color']) {
      expect(transition, `${property} is not transitioned`).toContain(property)
    }
    expect(transition).toContain('100ms')
    expect(transition).toContain('ease-in-out')

    const icon = declarations(css, ICON).get('transition') ?? ''
    expect(icon).toContain('opacity')
    expect(icon).toContain('100ms')
  })

  it('drops both transitions under reduced motion', () => {
    const block = reducedMotionBlock(css)
    expect(block, 'no reduced-motion guard covers the table handle').not.toBeNull()

    const guarded = block as string
    // Both halves: an unguarded icon fade is still motion on the screen.
    expect(guarded).toContain(HANDLE)
    expect(guarded).toContain("[data-test='tableHandle']")
    expect(guarded.replace(/\s+/g, ' ')).toContain('transition: none')
  })
})
