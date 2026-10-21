import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Below 768px the sidebar is a sheet with no `.peer` element, so the peer-based
 * rule that moves the first tab past the window-control buttons never matches.
 * jsdom has no cascade or media queries, so a source-level read is the guard.
 */
const MAIN_CSS = join(dirname(fileURLToPath(import.meta.url)), 'main.css')

describe('window-controls reserve in main.css', () => {
  it('keeps the first tab clear of the chrome buttons in narrow windows (#3431)', () => {
    const css = readFileSync(MAIN_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const narrow = css.match(/@media \(max-width: 767px\) \{([\s\S]*?\n\})\n/)?.[1] ?? ''
    expect(narrow).toContain('[data-reserve-window-controls]')
    expect(narrow).toContain('var(--chrome-buttons-width)')
    expect(narrow).not.toContain('.peer')
  })
})
