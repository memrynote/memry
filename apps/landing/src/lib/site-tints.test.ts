import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { PAGE_META } from './seo.ts'
import {
  getPageTint,
  HERO_TINT_CLASSES,
  SITE_TINTS,
  TINT_CLASSES,
  type HeroTint
} from './site-tints.ts'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

// The spec's in-scope page list, written out here on purpose: this file encodes the
// design decision, site-tints.ts encodes the implementation. If they drift, this fails.
const IN_SCOPE_PAGES = [
  'useCases',
  'notes',
  'tasks',
  'journal',
  'calendar',
  'inbox',
  'aiAgent',
  'webClipper',
  'cli',
  'compare',
  'privacy',
  'security'
]

// Pages that must stay untinted: home carries the painted wallpaper instead, the
// conversion and timeline pages run their heroes on the bare page ground, and the legal
// pages are out of scope entirely.
const UNTINTED_PAGES = [
  'home',
  'features',
  'pricing',
  'downloadDesktop',
  'roadmap',
  'changelog',
  'terms',
  'refund'
]

function tintToken(tint: HeroTint) {
  return tint === 'ink' ? '--color-dark' : `--color-tint-${tint}`
}

describe('site hero tints', () => {
  it('gives every in-scope page a tint', () => {
    for (const page of IN_SCOPE_PAGES) {
      assert.ok(getPageTint(page), `${page} is in scope but has no hero tint`)
    }
  })

  it('only names pages that actually exist', () => {
    for (const page of Object.keys(SITE_TINTS)) {
      assert.ok(PAGE_META[page], `SITE_TINTS names "${page}", which is not a PAGE_META page`)
    }
  })

  it('only uses tints that exist as CSS tokens', () => {
    for (const tint of Object.values(SITE_TINTS)) {
      const token = tintToken(tint)

      assert.ok(css.includes(`${token}:`), `Tint "${tint}" has no ${token} token in index.css`)
    }
  })

  // The landing site is light-only as of 2724277f0 ("feat(landing): remove the dark
  // theme"). There is no .dark block and no @custom-variant dark, so a tint is defined
  // exactly once. This guards the removal: a second definition means a dark block crept
  // back in without the design being reconsidered.
  it('defines every tint exactly once, because the site is light-only', () => {
    for (const tint of new Set(Object.values(SITE_TINTS))) {
      const token = tintToken(tint)
      const occurrences = css.split(`${token}:`).length - 1

      assert.equal(occurrences, 1, `${token} must be defined exactly once (found ${occurrences})`)
    }
  })

  it('routes every alternative page to the comparison tint', () => {
    const alternatives = Object.keys(PAGE_META).filter((page) => page.endsWith('Alternative'))

    assert.ok(alternatives.length > 0, 'expected PAGE_META to define alternative pages')

    for (const page of alternatives) {
      assert.equal(getPageTint(page), 'lilac', `${page} must use the comparison tint`)
    }
  })

  it('leaves the homepage and legal pages untinted', () => {
    for (const page of UNTINTED_PAGES) {
      assert.equal(getPageTint(page), undefined, `${page} must not have a hero tint`)
    }
  })

  // TypeScript enforces that the map is complete, but not that it is correct: it is
  // perfectly happy with `sky: 'bg-tint-sage'`. That mis-paint would be invisible in
  // review and obvious only on the page.
  it('maps every tint to its own background class', () => {
    for (const [tint, className] of Object.entries(TINT_CLASSES)) {
      assert.equal(className, `bg-tint-${tint}`, `${tint} is painted with ${className}`)
    }
  })

  it('gives the hero map the same pastels plus the ink surface', () => {
    assert.deepEqual(HERO_TINT_CLASSES, { ...TINT_CLASSES, ink: 'bg-dark' })
  })

  it('gives each feature page its own tint', () => {
    const featurePages = [
      'notes',
      'tasks',
      'journal',
      'calendar',
      'inbox',
      'aiAgent',
      'webClipper',
      'cli'
    ]
    const tints = featurePages.map((page) => getPageTint(page))

    assert.equal(new Set(tints).size, featurePages.length, 'feature page tints must be unique')
  })
})
