import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { DIRECT_NAV_LINKS, DOWNLOAD_NAV_ITEMS, FOOTER_LINKS } from './constants.ts'
import {
  BASE_URL,
  getArticleJsonLd,
  getBlogIndexJsonLd,
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
    const vercelConfig = JSON.parse(
      readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')
    ) as {
      redirects?: {
        has?: { type: string; value: string }[]
        destination: string
        permanent?: boolean
      }[]
    }

    // memrynote.ai is a legitimately owned alias domain. It may appear ONLY as a
    // redirect SOURCE that forwards to memrynote.com — that redirect is what makes
    // memrynote.com canonical, so banning the string outright (as this test used to)
    // would forbid the very mechanism it exists to protect. What must never happen is
    // .ai appearing as a destination, which would split link equity across two hosts.
    const redirects = vercelConfig.redirects ?? []
    const aliasRedirects = redirects.filter((redirect) =>
      redirect.has?.some((condition) => condition.value.endsWith('memrynote.ai'))
    )

    assert.ok(aliasRedirects.length > 0, 'expected memrynote.ai to be redirected to memrynote.com')

    for (const redirect of aliasRedirects) {
      assert.match(redirect.destination, /^https:\/\/memrynote\.com\//)
      assert.equal(redirect.permanent, true, 'alias redirects must be permanent to consolidate SEO')
    }

    for (const redirect of redirects) {
      assert.doesNotMatch(redirect.destination, /memrynote\.ai/)
    }
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
    assert.ok(DIRECT_NAV_LINKS.some((link) => link.href === '/roadmap'))
    assert.ok(FOOTER_LINKS.product.some((link) => link.href === '/features'))
    assert.ok(FOOTER_LINKS.product.some((link) => link.href === '/changelog'))
    assert.ok(FOOTER_LINKS.resources.some((link) => link.href === '/blog'))

    const desktopDownload = DOWNLOAD_NAV_ITEMS.find((item) => item.href === '/download/desktop')

    assert.equal(desktopDownload?.label, 'memrynote for Desktop')
    assert.notEqual(desktopDownload?.disabled, true)
  })

  it('emits WebSite JSON-LD for Google site identity', () => {
    const website = JSON.parse(getWebsiteJsonLd())

    assert.equal(website['@context'], 'https://schema.org')
    assert.equal(website['@type'], 'WebSite')
    assert.equal(website.name, 'memrynote')
    assert.deepEqual(website.alternateName, ['Memrynote', 'memrynote.com'])
    assert.equal(website.url, 'https://memrynote.com/')
    assert.equal(website.potentialAction, undefined)
  })

  it('emits Article Schema.org JSON-LD with author and publish dates for blog posts', () => {
    const article = JSON.parse(
      getArticleJsonLd({
        slug: 'test-article-slug',
        title: 'Test Article Title',
        description: 'Test article description for SEO.',
        datePublished: '2026-08-31T08:00:00.000Z',
        dateModified: '2026-08-31T09:00:00.000Z',
        author: { name: 'Kaan Karaca', url: 'https://x.com/h4yfans' }
      })
    )

    assert.equal(article['@context'], 'https://schema.org')
    assert.equal(article['@type'], 'Article')
    assert.equal(article.headline, 'Test Article Title')
    assert.equal(article.description, 'Test article description for SEO.')
    assert.equal(article.datePublished, '2026-08-31T08:00:00.000Z')
    assert.equal(article.dateModified, '2026-08-31T09:00:00.000Z')
    assert.equal(article.author['@type'], 'Person')
    assert.equal(article.author.name, 'Kaan Karaca')
    assert.equal(article.publisher['@type'], 'Organization')
    assert.equal(article.publisher.name, 'memrynote')
    assert.equal(article.mainEntityOfPage['@id'], 'https://memrynote.com/blog/test-article-slug')
  })

  it('emits CollectionPage JSON-LD for the blog index', () => {
    const collection = JSON.parse(
      getBlogIndexJsonLd([
        {
          slug: 'post-1',
          title: 'Post 1 Title',
          description: 'Post 1 Description',
          datePublished: '2026-08-31T08:00:00.000Z'
        }
      ])
    )

    assert.equal(collection['@context'], 'https://schema.org')
    assert.equal(collection['@type'], 'CollectionPage')
    assert.equal(collection.url, 'https://memrynote.com/blog')
    assert.equal(collection.hasPart?.length, 1)
    assert.equal(collection.hasPart[0]['@type'], 'Article')
    assert.equal(collection.hasPart[0].url, 'https://memrynote.com/blog/post-1')
  })
})
