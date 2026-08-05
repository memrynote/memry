import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildRobotsTxt, buildSitemapXml, getIndexablePaths } from './crawl-files.ts'
import { BASE_URL, SITELINK_CANDIDATE_PATHS } from './seo.ts'

describe('landing crawl files', () => {
  it('indexes every metadata-backed route once', () => {
    const paths = getIndexablePaths()

    assert.equal(new Set(paths).size, paths.length)

    for (const path of SITELINK_CANDIDATE_PATHS) {
      assert.ok(paths.includes(path), `${path} is missing from indexable paths`)
    }
  })

  it('builds an XML sitemap with absolute memrynote.com URLs', () => {
    const sitemap = buildSitemapXml(['/', '/pricing', '/changelog'])

    assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
    assert.match(sitemap, /<loc>https:\/\/memrynote\.com\/<\/loc>/)
    assert.match(sitemap, /<loc>https:\/\/memrynote\.com\/pricing<\/loc>/)
    assert.match(sitemap, /<loc>https:\/\/memrynote\.com\/changelog<\/loc>/)
    assert.doesNotMatch(sitemap, /memrynote\.ai/)
  })

  it('omits lastmod rather than stamping every URL with the build date', () => {
    assert.doesNotMatch(buildSitemapXml(), /<lastmod>/)
  })

  it('builds robots.txt pointing crawlers at the sitemap', () => {
    assert.equal(buildRobotsTxt(), `User-agent: *\nAllow: /\n\nSitemap: ${BASE_URL}/sitemap.xml\n`)
  })
})
