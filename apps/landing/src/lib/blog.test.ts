import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BLOG_POSTS,
  getAllCategories,
  getAllPosts,
  getAllTags,
  getPostBySlug,
  getRelatedPosts
} from './blog.ts'
import { PAGE_META } from './seo.ts'

describe('blog editorial surface', () => {
  it('contains at least 5 defensible, in-depth editorial articles', () => {
    const posts = getAllPosts()
    assert.ok(posts.length >= 5, `Expected at least 5 posts, got ${posts.length}`)
  })

  it('binds every blog post to a valid PAGE_META entry and clean path', () => {
    for (const post of BLOG_POSTS) {
      const meta = PAGE_META[post.pageKey]
      assert.ok(meta, `Post ${post.slug} has no PAGE_META entry for pageKey "${post.pageKey}"`)
      assert.equal(meta.path, `/blog/${post.slug}`, `Path mismatch for ${post.slug}`)
      assert.equal(meta.title, `${post.title} — memrynote`)
      assert.ok(meta.description.length >= 50, `Description for ${post.slug} is too short`)
    }
  })

  it('gives each post substantive depth with sections, takeaways, and related features', () => {
    for (const post of BLOG_POSTS) {
      assert.ok(post.title.length > 10, `Post ${post.slug} title is too short`)
      assert.ok(post.lead.length > 50, `Post ${post.slug} lead is too short`)
      assert.ok(post.sections.length >= 3, `Post ${post.slug} must have at least 3 sections`)
      assert.ok(post.takeaways.length >= 3, `Post ${post.slug} must have at least 3 takeaways`)
      assert.ok(post.author.name, `Post ${post.slug} is missing author name`)
      assert.match(
        post.datePublished,
        /^\d{4}-\d{2}-\d{2}T/,
        `Post ${post.slug} invalid datePublished`
      )
      assert.match(
        post.dateModified,
        /^\d{4}-\d{2}-\d{2}T/,
        `Post ${post.slug} invalid dateModified`
      )
      assert.ok(post.readingTime.includes('min read'), `Post ${post.slug} invalid reading time`)
      assert.ok(post.tags.length >= 2, `Post ${post.slug} should have at least 2 tags`)

      // Total words in section paragraphs
      const totalWords = post.sections
        .flatMap((s) => s.paragraphs)
        .join(' ')
        .split(/\s+/).length
      assert.ok(totalWords >= 300, `Post ${post.slug} is too brief (${totalWords} words)`)

      // Related feature must link to an existing landing page
      const featurePaths = Object.values(PAGE_META).map((m) => m.path)
      assert.ok(
        featurePaths.includes(post.relatedFeature.href),
        `Post ${post.slug} relates to invalid feature link "${post.relatedFeature.href}"`
      )
    }
  })

  it('looks up post by slug and returns undefined for unknown slugs', () => {
    const post = getPostBySlug('how-to-keep-a-plain-text-daily-journal-that-outlives-any-app')
    assert.ok(post)
    assert.equal(post.slug, 'how-to-keep-a-plain-text-daily-journal-that-outlives-any-app')

    const missing = getPostBySlug('non-existent-article-slug')
    assert.equal(missing, undefined)
  })

  it('provides related posts excluding the current article', () => {
    const currentSlug = 'how-to-keep-a-plain-text-daily-journal-that-outlives-any-app'
    const related = getRelatedPosts(currentSlug, 2)

    assert.equal(related.length, 2)
    for (const p of related) {
      assert.notEqual(p.slug, currentSlug)
    }
  })

  it('extracts unique categories and tags across the publication', () => {
    const categories = getAllCategories()
    assert.ok(categories.length >= 3)
    assert.equal(new Set(categories).size, categories.length)

    const tags = getAllTags()
    assert.ok(tags.length >= 5)
    assert.equal(new Set(tags).size, tags.length)
  })
})
