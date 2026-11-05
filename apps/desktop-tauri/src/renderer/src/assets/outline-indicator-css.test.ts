import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The info panel's entrance animation is an unlayered base.css rule, so a
 * Tailwind `motion-reduce:` utility (inside `@layer utilities`) cannot turn it
 * off. jsdom has no cascade, so a source-level read is the guard.
 */
const BASE_CSS = join(dirname(fileURLToPath(import.meta.url)), 'base.css')

function reducedMotionDeclarationsFor(selector: string): string {
  const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ')
  const css = readFileSync(BASE_CSS, 'utf8')
    .replace(/^[ \t]*@[a-z-]+[^;{}\n]*;[ \t]*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const bodies: string[] = []
  for (const [, block] of css.matchAll(
    /@media \(prefers-reduced-motion: reduce\) \{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g
  )) {
    for (const [, selectorList, body] of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (selectorList.split(',').map(normalize).includes(selector)) bodies.push(normalize(body))
    }
  }
  return bodies.join(' ')
}

describe('outline info panel motion in base.css', () => {
  it('drops the entrance animation under reduced motion (#2779)', () => {
    expect(reducedMotionDeclarationsFor('.outline-indicator')).toContain('animation: none')
  })

  it('slides the panel in sideways only, so it ends where it started (#3530)', () => {
    // The info panel is anchored by its top edge. A vertical shift in the entrance animation
    // moved it up by half its height until the animation ended, then it jumped back: a pointer
    // that had opened it mid-animation was left on its edge and the panel closed under it.
    const css = readFileSync(BASE_CSS, 'utf8')
    const keyframes = /@keyframes outline-fade-in \{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/.exec(css)?.[1]
    expect(keyframes).toBeDefined()
    expect(keyframes).not.toMatch(/translateY|translate3d|\btranslate\s*:/)
  })
})
