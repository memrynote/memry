import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { DIRECT_NAV_LINKS, FOOTER_LINKS } from './constants.ts'
import {
  BASE_URL,
  getArticleJsonLd,
  getBlogIndexJsonLd,
  getCanonicalUrl,
  getWebsiteJsonLd,
  PAGE_META,
  SITELINK_CANDIDATE_PATHS
} from './seo.ts'

type VercelRedirect = {
  source: string
  has?: { type: string; value: string }[]
  destination: string
  permanent?: boolean
}

function readVercelRedirects(): VercelRedirect[] {
  const config = JSON.parse(
    readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')
  ) as { redirects?: VercelRedirect[] }

  return config.redirects ?? []
}

describe('landing SEO signals', () => {
  it('uses memrynote.com as the canonical host', () => {
    assert.equal(BASE_URL, 'https://memrynote.com')
    assert.equal(getCanonicalUrl('/pricing'), 'https://memrynote.com/pricing')
    assert.doesNotMatch(JSON.stringify(PAGE_META), /memrynote\.ai/)
  })

  it('keeps landing deployment config focused on memrynote.com', () => {
    // memrynote.ai is a legitimately owned alias domain. It may appear ONLY as a
    // redirect SOURCE that forwards to memrynote.com — that redirect is what makes
    // memrynote.com canonical, so banning the string outright (as this test used to)
    // would forbid the very mechanism it exists to protect. What must never happen is
    // .ai appearing as a destination, which would split link equity across two hosts.
    const redirects = readVercelRedirects()
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

  it('keeps the retired /download/desktop URL forwarding to /download', () => {
    // Shipped desktop builds (the update-failed dialog), sent emails, the docs install
    // guide and search indexes all link to /download/desktop, so it must keep forwarding.
    // /download must never forward back: the old 308 ran that way, and a reverse entry
    // would bounce visitors between the two URLs.
    const redirects = readVercelRedirects()
    const legacy = redirects.find((redirect) => redirect.source === '/download/desktop')

    assert.equal(legacy?.destination, '/download')
    assert.equal(legacy?.permanent, true)
    assert.ok(
      !redirects.some((redirect) => redirect.source === '/download'),
      '/download is the page itself, not a redirect'
    )
  })

  it('keeps the main sitelink candidates as real route metadata', () => {
    assert.deepEqual(SITELINK_CANDIDATE_PATHS, [
      '/',
      '/features',
      '/pricing',
      '/download',
      '/changelog',
      '/roadmap'
    ])

    const indexedPaths = new Set(Object.values(PAGE_META).map((meta) => meta.path))

    for (const path of SITELINK_CANDIDATE_PATHS) {
      assert.ok(indexedPaths.has(path), `${path} is missing PAGE_META`)
    }
  })

  it('links the main sitelink candidates from visible navigation surfaces', () => {
    assert.ok(DIRECT_NAV_LINKS.some((link) => link.href === '/download'))
    assert.ok(DIRECT_NAV_LINKS.some((link) => link.href === '/roadmap'))
    assert.ok(FOOTER_LINKS.product.some((link) => link.href === '/features'))
    assert.ok(FOOTER_LINKS.product.some((link) => link.href === '/download'))
    assert.ok(FOOTER_LINKS.product.some((link) => link.href === '/changelog'))
    assert.ok(FOOTER_LINKS.resources.some((link) => link.href === '/blog'))
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

  it('adds a FAQPage next to the Article when a blog post has FAQs', () => {
    const graph = JSON.parse(
      getArticleJsonLd({
        slug: 'test-article-slug',
        title: 'Test Article Title',
        description: 'Test article description for SEO.',
        datePublished: '2026-08-31T08:00:00.000Z',
        author: { name: 'Kaan Karaca' },
        faqs: [{ question: 'Is it encrypted?', answer: 'Yes, on your device.' }]
      })
    )

    assert.equal(graph['@context'], 'https://schema.org')
    const [article, faqPage] = graph['@graph']
    assert.equal(article['@type'], 'Article')
    assert.equal(article.headline, 'Test Article Title')
    assert.equal(faqPage['@type'], 'FAQPage')
    assert.deepEqual(faqPage.mainEntity, [
      {
        '@type': 'Question',
        name: 'Is it encrypted?',
        acceptedAnswer: { '@type': 'Answer', text: 'Yes, on your device.' }
      }
    ])
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
