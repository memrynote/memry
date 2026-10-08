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
})
