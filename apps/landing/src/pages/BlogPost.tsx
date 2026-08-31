import { Link, useParams } from 'react-router'
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  CheckCircle2,
  Clock,
  Code2,
  Info,
  Lightbulb,
  AlertTriangle
} from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import {
  getPostBySlug,
  getRelatedPosts,
  type BlogPost,
  type BlogSection,
  type BlogCallout
} from '@/lib/blog'
import { PAGE_META } from '@/lib/seo'
import { TINT_CLASSES } from '@/lib/site-tints'
import { cn } from '@/lib/utils'
import { trackLandingEvent } from '@/lib/analytics'
import { NotFound } from './NotFound'

function formatDate(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

function CalloutBox({ callout }: { callout: BlogCallout }) {
  const isWarning = callout.type === 'warning'
  const isTip = callout.type === 'tip'

  const borderClass = isWarning
    ? 'border-amber-500/40 bg-amber-500/5 text-ink'
    : isTip
      ? 'border-sage/40 bg-sage/5 text-ink'
      : 'border-terracotta/40 bg-terracotta/5 text-ink'

  const iconClass = isWarning ? 'text-amber-600' : isTip ? 'text-sage' : 'text-terracotta'

  const Icon = isWarning ? AlertTriangle : isTip ? Lightbulb : Info

  return (
    <div className={cn('my-8 rounded-2xl border p-5 md:p-6', borderClass)}>
      <div className="flex items-start gap-3.5">
        <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', iconClass)} aria-hidden />
        <div>
          {callout.title && (
            <h4 className="font-sans font-semibold text-ink text-base mb-1.5">{callout.title}</h4>
          )}
          <p className="text-sm md:text-base leading-relaxed text-muted">{callout.text}</p>
        </div>
      </div>
    </div>
  )
}

function CodeBlockView({
  code,
  language,
  filename
}: {
  code: string
  language: string
  filename?: string
}) {
  return (
    <div className="my-8 overflow-hidden rounded-2xl border border-dark-border bg-dark text-ink-inverted shadow-card">
      {filename && (
        <div className="flex items-center justify-between border-b border-dark-border/80 px-4 py-2.5 font-mono text-xs text-dark-muted">
          <span className="flex items-center gap-2">
            <Code2 className="h-3.5 w-3.5 text-terracotta" />
            {filename}
          </span>
          <span className="uppercase text-[10px] tracking-wider text-dark-muted/60">
            {language}
          </span>
        </div>
      )}
      <pre className="overflow-x-auto p-4 md:p-6 font-mono text-xs md:text-sm leading-relaxed text-ink-inverted selection:bg-terracotta selection:text-white">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function ComparisonTableView({ table }: { table: NonNullable<BlogSection['table']> }) {
  return (
    <div className="my-8 overflow-x-auto rounded-2xl border border-border bg-card shadow-sm">
      <table className="w-full text-start text-sm md:text-base">
        <thead>
          <tr className="border-b border-border bg-paper-alt">
            {table.headers.map((header, idx) => (
              <th
                key={header}
                className={cn(
                  'px-4 py-3.5 font-serif font-medium text-ink',
                  idx === 0 ? 'text-start' : 'text-start'
                )}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {table.rows.map((row, rowIdx) => (
            <tr key={rowIdx} className="hover:bg-paper-alt/50 transition-colors">
              <td className="px-4 py-3.5 font-medium text-ink">{row[0]}</td>
              <td className="px-4 py-3.5 text-muted">{row[1]}</td>
              <td className="px-4 py-3.5 text-muted font-medium text-terracotta">{row[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SectionView({ section }: { section: BlogSection }) {
  return (
    <section className="mt-12 first:mt-8">
      <h2 className="font-serif text-2xl md:text-3xl text-ink font-normal leading-tight tracking-tight mb-5">
        {section.heading}
      </h2>

      {section.paragraphs.map((p, idx) => (
        <p key={idx} className="mb-5 text-base md:text-lg leading-relaxed text-muted">
          {p}
        </p>
      ))}

      {section.bullets && (
        <ul className="my-6 space-y-3 ps-2">
          {section.bullets.map((b, idx) => (
            <li
              key={idx}
              className="flex items-start gap-3 text-base md:text-lg leading-relaxed text-muted"
            >
              <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-terracotta" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}

      {section.callout && <CalloutBox callout={section.callout} />}
      {section.code && (
        <CodeBlockView
          code={section.code.code}
          language={section.code.language}
          filename={section.code.filename}
        />
      )}
      {section.table && <ComparisonTableView table={section.table} />}
    </section>
  )
}

export function BlogPostView({ post }: { post: BlogPost }) {
  const relatedPosts = getRelatedPosts(post.slug, 2)
  const tintClass = TINT_CLASSES[post.heroTint === 'ink' ? 'sand' : post.heroTint]

  return (
    <>
      <PageHead page={post.pageKey as keyof typeof PAGE_META} article={post} />

      <main className="pt-28 pb-28 sm:pt-36">
        <Container size="md">
          {/* Breadcrumbs */}
          <nav aria-label="Breadcrumbs" className="mb-8 flex items-center gap-2 text-xs text-muted">
            <Link to="/" className="hover:text-ink transition-colors">
              Home
            </Link>
            <span>/</span>
            <Link to="/blog" className="hover:text-ink transition-colors">
              Blog
            </Link>
            <span>/</span>
            <span className="truncate text-ink font-medium max-w-[280px] sm:max-w-md">
              {post.title}
            </span>
          </nav>

          {/* Article Header */}
          <header className="mb-12 border-b border-border pb-10">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted mb-4">
              <span
                className={cn(
                  'rounded-full px-3 py-1 font-mono-accent text-[11px] font-medium uppercase tracking-[0.14em] text-ink',
                  tintClass
                )}
              >
                {post.category}
              </span>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" aria-hidden />
                <time dateTime={post.datePublished}>{formatDate(post.datePublished)}</time>
              </span>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" aria-hidden />
                {post.readingTime}
              </span>
            </div>

            <h1 className="font-serif text-3xl md:text-5xl text-ink font-normal leading-[1.1] tracking-tight text-balance">
              {post.title}
            </h1>

            <p className="mt-6 text-lg md:text-xl leading-relaxed text-muted font-normal text-balance">
              {post.lead}
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-between gap-4 pt-6 border-t border-border/60">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-terracotta text-white font-serif text-sm font-medium">
                  KK
                </div>
                <div>
                  <p className="text-sm font-medium text-ink">{post.author.name}</p>
                  <p className="text-xs text-muted">{post.author.role}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Link
                  to="/blog"
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted hover:text-ink hover:bg-paper-alt transition-colors"
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> Back to Blog
                </Link>
              </div>
            </div>
          </header>

          {/* Article Body Content */}
          <article className="max-w-3xl">
            {post.sections.map((section) => (
              <SectionView key={section.heading} section={section} />
            ))}

            {/* Key Takeaways Box */}
            <div className="my-14 rounded-3xl border border-sage/30 bg-sage/5 p-6 md:p-8">
              <div className="flex items-center gap-2.5 mb-4">
                <CheckCircle2 className="h-5 w-5 text-sage" />
                <h3 className="font-serif text-xl text-ink font-medium">Key Takeaways</h3>
              </div>
              <ul className="space-y-3">
                {post.takeaways.map((takeaway, idx) => (
                  <li
                    key={idx}
                    className="flex items-start gap-3 text-sm md:text-base leading-relaxed text-muted"
                  >
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-sage" />
                    <span>{takeaway}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Contextual Feature Recommendation */}
            <div className="my-12 overflow-hidden rounded-3xl border border-terracotta/20 bg-paper-alt p-6 md:p-8">
              <p className="font-mono-accent text-xs uppercase tracking-[0.2em] text-terracotta mb-2">
                In Memrynote
              </p>
              <h4 className="font-serif text-2xl text-ink font-normal mb-2">
                {post.relatedFeature.label}
              </h4>
              <p className="text-sm md:text-base text-muted leading-relaxed mb-5">
                {post.relatedFeature.description}
              </p>
              <Link
                to={post.relatedFeature.href}
                className="inline-flex items-center gap-2 rounded-full bg-terracotta px-5 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-terracotta/90"
                onClick={() => trackLandingEvent('landing_nav_click', `blog:cta:${post.slug}`)}
              >
                Learn more <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>

            {/* Author Bio Card */}
            <div className="mt-16 border-t border-border pt-8 flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-terracotta text-white font-serif text-base font-medium">
                KK
              </div>
              <div>
                <h4 className="text-base font-semibold text-ink">Written by {post.author.name}</h4>
                <p className="mt-1 text-sm text-muted leading-relaxed">
                  Building memrynote — a local-first, zero-knowledge encrypted second brain for
                  thought, tasks, and daily writing.
                </p>
                {post.author.url && (
                  <a
                    href={post.author.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block text-xs font-medium text-terracotta hover:underline"
                  >
                    Follow on X / Twitter →
                  </a>
                )}
              </div>
            </div>
          </article>

          {/* Related Articles Section */}
          {relatedPosts.length > 0 && (
            <section className="mt-20 border-t border-border pt-12">
              <h3 className="font-serif text-2xl text-ink font-normal mb-6">
                Related Guides &amp; Essays
              </h3>
              <div className="grid gap-6 md:grid-cols-2">
                {relatedPosts.map((related) => (
                  <article
                    key={related.slug}
                    className="group rounded-2xl border border-border bg-card p-6 shadow-sm transition-all hover:border-ink/20 hover:shadow-card"
                  >
                    <span className="font-mono-accent text-[11px] uppercase tracking-wider text-muted">
                      {related.category} · {related.readingTime}
                    </span>
                    <h4 className="mt-2 font-serif text-xl font-normal leading-tight text-ink group-hover:text-terracotta transition-colors">
                      <Link to={`/blog/${related.slug}`}>{related.title}</Link>
                    </h4>
                    <p className="mt-2 text-xs md:text-sm text-muted line-clamp-2 leading-relaxed">
                      {related.description}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          )}
        </Container>
      </main>
    </>
  )
}

// Individual static page wrappers for server-side prerendering & client routing
export function JournalLongevityPostPage() {
  const post = getPostBySlug('how-to-keep-a-plain-text-daily-journal-that-outlives-any-app')
  if (!post) return <NotFound />
  return <BlogPostView post={post} />
}

export function E2EEncryptionPostPage() {
  const post = getPostBySlug('what-end-to-end-encrypted-notes-actually-means')
  if (!post) return <NotFound />
  return <BlogPostView post={post} />
}

export function LocalFirstOfflinePostPage() {
  const post = getPostBySlug('local-first-vs-cloud-first-note-taking-apps')
  if (!post) return <NotFound />
  return <BlogPostView post={post} />
}

export function TerminalPkmPostPage() {
  const post = getPostBySlug('running-a-pkm-from-the-terminal')
  if (!post) return <NotFound />
  return <BlogPostView post={post} />
}

export function MarkdownMigrationPostPage() {
  const post = getPostBySlug('migrating-from-evernote-notion-to-markdown')
  if (!post) return <NotFound />
  return <BlogPostView post={post} />
}

// Generalized dynamic client route fallback
export function DynamicBlogPostPage() {
  const { slug } = useParams<{ slug: string }>()
  if (!slug) return <NotFound />
  const post = getPostBySlug(slug)
  if (!post) return <NotFound />
  return <BlogPostView post={post} />
}
