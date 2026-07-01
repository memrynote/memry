import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { DIRECT_NAV_LINKS, DOWNLOAD_NAV_ITEMS, FOOTER_LINKS } from './constants.ts'
import {
  BASE_URL,
  getCanonicalUrl,
  getWebsiteJsonLd,
  PAGE_META,
  SITELINK_CANDIDATE_PATHS
} from './seo.ts'

describe('landing SEO signals', () => {
  it('uses memrynote.com as the canonical host', () => {
    assert.equal(BASE_URL, 'https://memrynote.com')
    assert.equal(getCanonicalUrl('/pricing'), 'https://memrynote.com/pricing')
    assert.doesNotMatch(JSON.stringify(PAGE_META), /memrynote\.ai/)
  })

  it('keeps landing deployment config focused on memrynote.com', () => {
    const vercelConfig = readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')

    assert.doesNotMatch(vercelConfig, /memrynote\.ai/)
  })

  it('keeps the main sitelink candidates as real route metadata', () => {
    assert.deepEqual(SITELINK_CANDIDATE_PATHS, [
      '/',
      '/features',
      '/pricing',
      '/download/desktop',
      '/changelog',
      '/roadmap'
    ])

    const indexedPaths = new Set(Object.values(PAGE_META).map((meta) => meta.path))

    for (const path of SITELINK_CANDIDATE_PATHS) {
      assert.ok(indexedPaths.has(path), `${path} is missing PAGE_META`)
    }
  })

  it('links the main sitelink candidates from visible navigation surfaces', () => {
    assert.ok(DIRECT_NAV_LINKS.some((link) => link.href === '/changelog'))
    assert.ok(FOOTER_LINKS.product.some((link) => link.href === '/features'))
    assert.ok(FOOTER_LINKS.product.some((link) => link.href === '/changelog'))

    const desktopDownload = DOWNLOAD_NAV_ITEMS.find((item) => item.href === '/download/desktop')

    assert.equal(desktopDownload?.label, 'memrynote for Desktop')
    assert.notEqual(desktopDownload?.disabled, true)
  })

  it('emits WebSite JSON-LD for Google site identity', () => {
    const website = JSON.parse(getWebsiteJsonLd())

    assert.equal(website['@context'], 'https://schema.org')
    assert.equal(website['@type'], 'WebSite')
    assert.equal(website.name, 'memrynote')
    assert.deepEqual(website.alternateName, ['MemryNote', 'memrynote.com'])
    assert.equal(website.url, 'https://memrynote.com/')
    assert.equal(website.potentialAction, undefined)
  })
})
