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
    assert.doesNotMatch(readRule('.dark body'), /background-blend-mode/)
  })

  it('keeps the page grain self-contained at low opacity', () => {
    const opacityMatch = readRule('body').match(/%3Crect[^"]*opacity='([0-9.]+)'/)

    assert.ok(opacityMatch, 'Body noise SVG must define its own opacity')
    assert.ok(Number(opacityMatch[1]) <= 0.05, 'Body noise SVG opacity must stay subtle')
  })
})
