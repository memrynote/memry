import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowRight, BookOpen, Clock, Calendar, Sparkles } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { PageHero } from '@/components/site/PageHero'
import { FeatureChip } from '@/components/site/primitives'
import { BLOG_POSTS, getAllCategories, type BlogPost } from '@/lib/blog'
import { getBlogIndexJsonLd } from '@/lib/seo'
import { TINT_CLASSES } from '@/lib/site-tints'
import { cn } from '@/lib/utils'
import { trackLandingEvent } from '@/lib/analytics'

function formatDate(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

function PostCard({ post }: { post: BlogPost }) {
  const tintClass = TINT_CLASSES[post.heroTint === 'ink' ? 'sand' : post.heroTint]

  return (
    <article className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-border/80 bg-card p-6 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-ink/20 hover:shadow-card md:p-8">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono-accent text-[11px] font-medium uppercase tracking-[0.14em] text-ink',
              tintClass
            )}
          >
            {post.category}
          </span>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" aria-hidden />
              <time dateTime={post.datePublished}>{formatDate(post.datePublished)}</time>
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" aria-hidden />
              {post.readingTime}
            </span>
          </div>
        </div>

        <h3 className="mt-5 font-serif text-2xl font-normal leading-tight text-ink transition-colors group-hover:text-terracotta">
          <Link
            to={`/blog/${post.slug}`}
            onClick={() => trackLandingEvent('landing_nav_click', `blog:card:${post.slug}`)}
          >
            {post.title}
          </Link>
        </h3>

        <p className="mt-3 text-sm leading-relaxed text-muted line-clamp-3 md:text-base">
          {post.description}
        </p>
      </div>

      <div className="mt-6 pt-5 border-t border-border/60 flex items-center justify-between">
        <div className="flex flex-wrap gap-1.5">
          {post.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center rounded-md bg-paper-alt px-2 py-0.5 font-mono-accent text-[11px] text-muted"
            >
              #{tag}
            </span>
          ))}
        </div>
        <Link
          to={`/blog/${post.slug}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-terracotta transition-transform group-hover:translate-x-1"
          onClick={() => trackLandingEvent('landing_nav_click', `blog:read-more:${post.slug}`)}
        >
          Read <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </article>
  )
}

export function BlogIndexPage() {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const categories = getAllCategories()

  const filteredPosts = selectedCategory
    ? BLOG_POSTS.filter((post) => post.category === selectedCategory)
    : BLOG_POSTS

  const featuredPost = BLOG_POSTS.find((post) => post.featured) ?? BLOG_POSTS[0]
  const jsonLd = getBlogIndexJsonLd(BLOG_POSTS)

  return (
    <>
      <PageHead page="blog" collectionJsonLd={jsonLd} />
      <PageHero
        tint="sand"
        eyebrow="The memrynote journal & publication"
        title={
          <>
            Notes on privacy, cryptography &amp;{' '}
            <span className="text-terracotta">plain-text longevity.</span>
          </>
        }
        sub="In-depth essays, architectural breakdowns, and practical guides on personal knowledge management, local-first systems, and owning your memories."
        actions={
          <>
            <FeatureChip
              icon={<BookOpen className="h-4 w-4 text-terracotta" />}
              label="Why local-first matters"
              href="/blog/local-first-vs-cloud-first-note-taking-apps"
              trailingIcon={<ArrowRight className="h-4 w-4" />}
            />
            <FeatureChip
              icon={<Sparkles className="h-4 w-4 text-terracotta" />}
              label="Demystifying E2EE"
              href="/blog/what-end-to-end-encrypted-notes-actually-means"
              trailingIcon={<ArrowRight className="h-4 w-4" />}
            />
          </>
        }
      />

      <main className="pb-28 pt-8">
        <Container size="md">
          {/* Featured Article Banner */}
          {featuredPost && !selectedCategory && (
            <section className="mb-14">
              <div className="flex items-center gap-2 mb-4">
                <span className="flex h-2 w-2 rounded-full bg-terracotta" />
                <h2 className="font-mono-accent text-xs uppercase tracking-[0.2em] text-muted">
                  Featured Guide
                </h2>
              </div>
              <div className="group relative overflow-hidden rounded-3xl border border-border/80 bg-paper-alt p-8 transition-all hover:border-ink/20 hover:shadow-elevated md:p-12">
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted mb-4">
                  <span className="rounded-full bg-terracotta/10 px-3 py-1 font-mono-accent text-[11px] font-medium uppercase tracking-[0.14em] text-terracotta">
                    {featuredPost.category}
                  </span>
                  <span>·</span>
                  <time dateTime={featuredPost.datePublished}>
                    {formatDate(featuredPost.datePublished)}
                  </time>
                  <span>·</span>
                  <span>{featuredPost.readingTime}</span>
                </div>

                <h3 className="font-serif text-3xl md:text-4xl text-ink font-normal leading-tight transition-colors group-hover:text-terracotta">
                  <Link
                    to={`/blog/${featuredPost.slug}`}
                    onClick={() =>
                      trackLandingEvent('landing_nav_click', `blog:featured:${featuredPost.slug}`)
                    }
                  >
                    {featuredPost.title}
                  </Link>
                </h3>

                <p className="mt-4 max-w-3xl text-base md:text-lg leading-relaxed text-muted">
                  {featuredPost.summary}
                </p>

                <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-terracotta text-white font-serif text-sm">
                      KK
                    </div>
                    <div>
                      <p className="text-sm font-medium text-ink">{featuredPost.author.name}</p>
                      <p className="text-xs text-muted">{featuredPost.author.role}</p>
                    </div>
                  </div>

                  <Link
                    to={`/blog/${featuredPost.slug}`}
                    className="inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-xs font-semibold text-paper shadow-sm transition-all hover:bg-ink/90 group-hover:bg-terracotta"
                    onClick={() =>
                      trackLandingEvent(
                        'landing_nav_click',
                        `blog:featured-btn:${featuredPost.slug}`
                      )
                    }
                  >
                    Read article <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            </section>
          )}

          {/* Category Filter Bar */}
          <div className="mb-10 flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedCategory(null)}
                className={cn(
                  'rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors',
                  selectedCategory === null
                    ? 'bg-ink text-paper'
                    : 'bg-paper-alt text-muted hover:text-ink'
                )}
              >
                All Articles ({BLOG_POSTS.length})
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  className={cn(
                    'rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors',
                    selectedCategory === cat
                      ? 'bg-ink text-paper'
                      : 'bg-paper-alt text-muted hover:text-ink'
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>

            <p className="font-mono-accent text-xs text-muted">
              Showing {filteredPosts.length} {filteredPosts.length === 1 ? 'article' : 'articles'}
            </p>
          </div>

          {/* Posts Grid */}
          <section className="grid gap-6 md:grid-cols-2">
            {filteredPosts.map((post) => (
              <PostCard key={post.slug} post={post} />
            ))}
          </section>

          {/* Newsletter / RSS / Philosophy Footnote */}
          <section className="mt-20 overflow-hidden rounded-3xl border border-border bg-paper-alt p-8 text-center md:p-12">
            <h3 className="font-serif text-2xl md:text-3xl text-ink font-normal">
              Built on the belief that your thoughts belong to you.
            </h3>
            <p className="mx-auto mt-3 max-w-xl text-sm md:text-base leading-relaxed text-muted">
              memrynote is an open-source, local-first workspace for notes, tasks, calendar, and
              daily journaling. Free forever for local vaults.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
              <Link
                to="/download/desktop"
                className="inline-flex items-center gap-2 rounded-full bg-terracotta px-6 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-terracotta/90"
              >
                Download Memrynote
              </Link>
              <Link
                to="/security"
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-6 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-paper-alt"
              >
                Security &amp; Encryption
              </Link>
            </div>
          </section>
        </Container>
      </main>
    </>
  )
}
