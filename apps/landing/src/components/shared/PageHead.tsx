import { Helmet } from 'react-helmet-async'
import {
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

interface PageHeadProps {
  page: keyof typeof PAGE_META
  jsonLd?: boolean
}

export function PageHead({ page, jsonLd }: PageHeadProps) {
  const meta = PAGE_META[page]
  const canonical = getCanonicalUrl(meta.path)
  const breadcrumb = getBreadcrumbJsonLd(page)

  return (
    <Helmet>
      <title>{meta.title}</title>
      <meta name="description" content={meta.description} />
      <link rel="canonical" href={canonical} />

      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={meta.title} />
      <meta property="og:description" content={meta.description} />
      <meta property="og:url" content={canonical} />
      <meta property="og:image" content={SOCIAL_IMAGE_URL} />
      <meta property="og:image:width" content={SOCIAL_IMAGE_WIDTH} />
      <meta property="og:image:height" content={SOCIAL_IMAGE_HEIGHT} />
      <meta property="og:image:alt" content={SOCIAL_IMAGE_ALT} />

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:site" content={TWITTER_HANDLE} />
      <meta name="twitter:title" content={meta.title} />
      <meta name="twitter:description" content={meta.description} />
      <meta name="twitter:url" content={canonical} />
      <meta name="twitter:image" content={SOCIAL_IMAGE_URL} />
      <meta name="twitter:image:alt" content={SOCIAL_IMAGE_ALT} />

      {jsonLd && <script type="application/ld+json">{getJsonLd()}</script>}
      {breadcrumb && <script type="application/ld+json">{breadcrumb}</script>}
    </Helmet>
  )
}
