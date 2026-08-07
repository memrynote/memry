import { z } from 'zod'

export const ArticlePropertiesSchema = z.object({
  title: z.string(),
  source: z.string(),
  author: z.string().optional(),
  published: z.string().optional(),
  created: z.string(),
  description: z.string().optional()
})

export const ArticleCaptureSchema = z.object({
  url: z.string().url(),
  mode: z.enum(['article', 'selection', 'screenshot', 'pdf']),
  contentMarkdown: z.string(),
  excerpt: z.string(),
  extractionStatus: z.enum(['full', 'partial', 'failed']),
  properties: ArticlePropertiesSchema,
  heroImage: z.string().optional(),
  screenshotDataUrl: z.string().optional(),
  // Base64 data URL of the tab's PDF, set only by the extension's pdf mode.
  // Capped at 16MB raw client-side so it fits the /capture body limit.
  pdfDataUrl: z.string().optional(),
  pdfFilename: z.string().optional(),
  tags: z.array(z.string()).optional(),
  force: z.boolean().optional()
})

export type ArticleCaptureInput = z.infer<typeof ArticleCaptureSchema>
