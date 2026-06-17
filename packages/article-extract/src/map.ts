export interface ArticleProperties {
  title: string
  source: string
  author?: string[]
  published?: string
  created: string
  description?: string
  tags: string[]
}

export interface ArticleCapture {
  url: string
  mode: 'article' | 'selection' | 'screenshot'
  contentMarkdown: string
  excerpt: string
  extractionStatus: 'full' | 'partial' | 'failed'
  properties: ArticleProperties
  heroImage?: string
  // Capture directives (set by the extension for selection/screenshot; the
  // extraction mapping never sets them).
  force?: boolean
  screenshotDataUrl?: string
}

export interface DefuddleLikeResult {
  content?: string
  title?: string
  author?: string
  published?: string
  description?: string
  image?: string
  wordCount?: number
}

const PARTIAL_WORD_THRESHOLD = 100

function extractionStatusFor(
  content: string,
  wordCount: number
): ArticleCapture['extractionStatus'] {
  if (!content.trim()) return 'failed'
  if (wordCount < PARTIAL_WORD_THRESHOLD) return 'partial'
  return 'full'
}

export function mapToArticleCapture(
  result: DefuddleLikeResult,
  url: string,
  opts: { now?: string } = {}
): ArticleCapture {
  const now = opts.now ?? new Date().toISOString()
  const contentMarkdown = result.content ?? ''
  const wordCount = result.wordCount ?? 0
  const title = result.title?.trim() || url

  const properties: ArticleProperties = {
    title,
    source: url,
    created: now,
    tags: ['clippings']
  }
  if (result.author?.trim()) properties.author = [result.author.trim()]
  if (result.published?.trim()) properties.published = result.published.trim()
  if (result.description?.trim()) properties.description = result.description.trim()

  return {
    url,
    mode: 'article',
    contentMarkdown,
    excerpt: result.description?.trim() || contentMarkdown.slice(0, 200),
    extractionStatus: extractionStatusFor(contentMarkdown, wordCount),
    properties,
    heroImage: result.image?.trim() || undefined
  }
}
