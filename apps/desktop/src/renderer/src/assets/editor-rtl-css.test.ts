import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * BlockNote's stylesheet indents nested blocks with `margin-left` and draws the
 * quote bar with `border-left`; neither reads `dir`. jsdom has no cascade, so a
 * source-level read guards that the RTL mirror stays imported and keeps those rules.
 */
const ASSETS = dirname(fileURLToPath(import.meta.url))
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('editor RTL mirror', () => {
  it('is imported by main.css', () => {
    expect(readFileSync(join(ASSETS, 'main.css'), 'utf8')).toContain("@import './editor-rtl.css'")
  })

  it('indents nested blocks and moves the quote bar to the inline start', () => {
    const css = strip(readFileSync(join(ASSETS, 'editor-rtl.css'), 'utf8'))
    expect(css).toMatch(
      /\.bn-block-group \.bn-block-group:dir\(rtl\) \{[^}]*margin-inline-start: 24px/
    )
    expect(css).toMatch(
      /\[data-content-type='quote'\]:dir\(rtl\) blockquote \{[^}]*border-right: 3px/
    )
  })
})
