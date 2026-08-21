import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')

function readRule(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'))

  assert.ok(match, `Missing ${selector} rule`)

  return match[1]
}

describe('landing page background CSS', () => {
  it('does not depend on blend-mode support for the page grain', () => {
    assert.doesNotMatch(readRule('body'), /background-blend-mode/)
    assert.doesNotMatch(readRule('.page-texture'), /blend-mode/)
  })

  it('keeps the page grain self-contained and bounded', () => {
    const opacityMatch = readRule(':root').match(/%3Crect[^"]*opacity='([0-9.]+)'/)

    assert.ok(opacityMatch, 'Page grain SVG must define its own opacity')
    // The grain carries the page texture now, so it is stronger than the old
    // near-invisible 0.022 — but it still has to read as paper, not as static.
    assert.ok(Number(opacityMatch[1]) <= 0.25, 'Page grain SVG opacity must stay subtle')
  })

  it('gives the dark zones the same grid with a light dot', () => {
    const zone = readRule('.zone-dark')

    assert.match(
      zone,
      /--page-dot-grid: radial-gradient\(circle, rgb\(245 240 234 \/ 0\.07\) 1px, transparent 1\.2px\);/
    )
    assert.match(zone, /background-image:\s*\n?\s*var\(--page-dot-grid\),/)
    assert.match(zone, /background-size:\s*\n?\s*14px 14px,/)
  })

  it('declares the dot grid once, at the grid size both surfaces share', () => {
    assert.match(
      readRule(':root'),
      /--page-dot-grid: radial-gradient\(circle,[^)]*\) 1px, transparent 1\.2px\);/
    )

    for (const selector of ['body', '.page-texture']) {
      const rule = readRule(selector)

      assert.match(
        rule,
        /background-image:\s*\n?\s*var\(--page-dot-grid\),\s*\n?\s*var\(--page-grain\);/
      )
      assert.match(rule, /background-size:\s*\n?\s*14px 14px,/)
    }
  })
})
