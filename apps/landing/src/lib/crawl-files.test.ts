import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BLOG_POSTS } from './blog.ts'
import { buildLlmsTxt, buildRobotsTxt, buildSitemapXml, getIndexablePaths } from './crawl-files.ts'
import { BASE_URL, SITELINK_CANDIDATE_PATHS } from './seo.ts'

describe('landing crawl files', () => {
  it('indexes every metadata-backed route once, including all blog posts', () => {
    const paths = getIndexablePaths()

    assert.equal(new Set(paths).size, paths.length)

    for (const path of SITELINK_CANDIDATE_PATHS) {
      assert.ok(paths.includes(path), `${path} is missing from indexable paths`)
    }

    assert.ok(paths.includes('/blog'), '/blog is missing from indexable paths')
    for (const post of BLOG_POSTS) {
      assert.ok(
        paths.includes(`/blog/${post.slug}`),
        `/blog/${post.slug} is missing from indexable paths`
      )
    }
  })

  it('builds an XML sitemap with absolute memrynote.com URLs', () => {
    const sitemap = buildSitemapXml(['/', '/pricing', '/changelog', '/blog'])

    assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
    assert.match(sitemap, /<loc>https:\/\/memrynote\.com\/<\/loc>/)
    assert.match(sitemap, /<loc>https:\/\/memrynote\.com\/pricing<\/loc>/)
    assert.match(sitemap, /<loc>https:\/\/memrynote\.com\/changelog<\/loc>/)
    assert.match(sitemap, /<loc>https:\/\/memrynote\.com\/blog<\/loc>/)
    assert.doesNotMatch(sitemap, /memrynote\.ai/)
  })

  it('omits lastmod rather than stamping every URL with the build date', () => {
    assert.doesNotMatch(buildSitemapXml(), /<lastmod>/)
  })

  it('builds robots.txt pointing crawlers at the sitemap', () => {
    assert.equal(buildRobotsTxt(), `User-agent: *\nAllow: /\n\nSitemap: ${BASE_URL}/sitemap.xml\n`)
  })

  it('includes blog index and all editorial posts in llms.txt', () => {
    const llms = buildLlmsTxt()

    assert.match(llms, /## Blog & Editorial Guides/)
    assert.match(llms, /- \[\/blog\]\(https:\/\/memrynote\.com\/blog\)/)
    for (const post of BLOG_POSTS) {
      assert.match(
        llms,
        new RegExp(
          `- \\[\\/blog\\/${post.slug}\\]\\(https:\\/\\/memrynote\\.com\\/blog\\/${post.slug}\\)`
        )
      )
    }
  })
})
