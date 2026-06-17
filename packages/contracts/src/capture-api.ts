import { z } from 'zod'

export const ArticlePropertiesSchema = z.object({
  title: z.string(),
  source: z.string(),
  author: z.array(z.string()).optional(),
  published: z.string().optional(),
  created: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string())
})

export const ArticleCaptureSchema = z.object({
  url: z.string().url(),
  mode: z.enum(['article', 'selection', 'screenshot']),
  contentMarkdown: z.string(),
  excerpt: z.string(),
  extractionStatus: z.enum(['full', 'partial', 'failed']),
  properties: ArticlePropertiesSchema,
  heroImage: z.string().optional(),
  screenshotDataUrl: z.string().optional(),
  tags: z.array(z.string()).optional(),
  force: z.boolean().optional()
})

export type ArticleCaptureInput = z.infer<typeof ArticleCaptureSchema>
