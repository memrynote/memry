import { Helmet } from 'react-helmet-async'
import {
  getAlternativeJsonLd,
  getArticleJsonLd,
  getBreadcrumbJsonLd,
  getCanonicalUrl,
  getJsonLd,
  PAGE_META,
  SITE_NAME,
  SOCIAL_IMAGE_ALT,
  SOCIAL_IMAGE_HEIGHT,
  SOCIAL_IMAGE_URL,
  SOCIAL_IMAGE_WIDTH,
  TWITTER_HANDLE
} from '@/lib/seo'
import type { BlogPost } from '@/lib/blog'

interface PageHeadProps {
  page: keyof typeof PAGE_META
  jsonLd?: boolean
  // When set (competitor alternative pages), emits a SoftwareApplication + FAQPage graph.
  faqs?: readonly { question: string; answer: string }[]
  // When set (blog post), emits Article Schema.org and article og tags.
  article?: BlogPost
  // When set (e.g. blog index), emits a CollectionPage Schema.org graph.
  collectionJsonLd?: string
}

export function PageHead({ page, jsonLd, faqs, article, collectionJsonLd }: PageHeadProps) {
  const meta = PAGE_META[page]
  const canonical = getCanonicalUrl(meta.path)
  const breadcrumb = getBreadcrumbJsonLd(page)

  return (
    <Helmet>
      <title>{meta.title}</title>
      <meta name="description" content={meta.description} />
      <link rel="canonical" href={canonical} />

      <meta property="og:type" content={article ? 'article' : 'website'} />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={meta.title} />
      <meta property="og:description" content={meta.description} />
      <meta property="og:url" content={canonical} />
      <meta property="og:image" content={SOCIAL_IMAGE_URL} />
      <meta property="og:image:width" content={SOCIAL_IMAGE_WIDTH} />
      <meta property="og:image:height" content={SOCIAL_IMAGE_HEIGHT} />
      <meta property="og:image:alt" content={SOCIAL_IMAGE_ALT} />

      {article && <meta property="article:published_time" content={article.datePublished} />}
      {article && <meta property="article:modified_time" content={article.dateModified} />}
      {article && <meta property="article:author" content={article.author.name} />}
      {article &&
        article.tags.map((tag) => <meta key={tag} property="article:tag" content={tag} />)}

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:site" content={TWITTER_HANDLE} />
      <meta name="twitter:title" content={meta.title} />
      <meta name="twitter:description" content={meta.description} />
      <meta name="twitter:url" content={canonical} />
      <meta name="twitter:image" content={SOCIAL_IMAGE_URL} />
      <meta name="twitter:image:alt" content={SOCIAL_IMAGE_ALT} />

      {jsonLd && <script type="application/ld+json">{getJsonLd()}</script>}
      {faqs && faqs.length > 0 && (
        <script type="application/ld+json">{getAlternativeJsonLd(faqs)}</script>
      )}
      {article && <script type="application/ld+json">{getArticleJsonLd(article)}</script>}
      {collectionJsonLd && <script type="application/ld+json">{collectionJsonLd}</script>}
      {breadcrumb && <script type="application/ld+json">{breadcrumb}</script>}
    </Helmet>
  )
}
