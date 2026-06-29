import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ALTERNATIVES } from './alternatives.ts'
import { PAGE_META } from './seo.ts'
import { FOOTER_LINKS } from './constants.ts'
import { buildLlmsTxt } from './crawl-files.ts'

describe('competitor alternative pages', () => {
  it('wires every config to PAGE_META and a clean URL, and links the hub from the footer', () => {
    const altPaths = new Set(ALTERNATIVES.map((alt) => PAGE_META[alt.pageKey].path))
    for (const alt of ALTERNATIVES) {
      const meta = PAGE_META[alt.pageKey]
      assert.ok(meta, `PAGE_META missing for ${alt.pageKey}`)
      assert.ok(meta.path.endsWith('-alternative'), `${meta.path} should end with -alternative`)
    }
    // Footer carries the hub + a marquee subset, not all 14; the long tail lives on /alternatives.
    assert.ok(
      FOOTER_LINKS.compare.some((link) => link.href === '/alternatives'),
      'footer compare must link the /alternatives hub'
    )
    for (const link of FOOTER_LINKS.compare) {
      if (link.href.endsWith('-alternative')) {
        assert.ok(altPaths.has(link.href), `footer marquee link has no page: ${link.href}`)
      }
    }
  })

  it('has an AlternativeConfig for every *-alternative page', () => {
    const configPaths = new Set(ALTERNATIVES.map((alt) => PAGE_META[alt.pageKey].path))
    for (const meta of Object.values(PAGE_META)) {
      if (meta.path.endsWith('-alternative')) {
        assert.ok(configPaths.has(meta.path), `no AlternativeConfig for ${meta.path}`)
      }
    }
  })

  it('gives every page enough depth to rank (sections, pricing, migration, FAQs)', () => {
    for (const alt of ALTERNATIVES) {
      assert.ok(alt.sections.length >= 3, `${alt.competitor}: needs >= 3 deep-dive sections`)
      assert.ok(alt.faqs.length >= 3, `${alt.competitor}: needs >= 3 FAQs`)
      assert.ok(alt.pricing.memry, `${alt.competitor}: pricing.memry required`)
      assert.ok(alt.pricing.competitor, `${alt.competitor}: pricing.competitor required`)
      assert.ok(alt.migration.steps.length >= 1, `${alt.competitor}: needs >= 1 migration step`)
    }
  })

  it('lists every alternative in llms.txt for AI-search discovery', () => {
    const llms = buildLlmsTxt()
    for (const alt of ALTERNATIVES) {
      const { path } = PAGE_META[alt.pageKey]
      assert.ok(llms.includes(path), `llms.txt missing ${path}`)
    }
  })
})
