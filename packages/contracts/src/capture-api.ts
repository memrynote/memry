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
  // Bounded because ingest stores it verbatim as metadata.originalFilename, which
  // then syncs — a hostile Content-Disposition must not be able to plant an
  // unbounded string. 255 is the usual filesystem name limit.
  pdfFilename: z.string().max(255).optional(),
  tags: z.array(z.string()).optional(),
  force: z.boolean().optional(),
  // Optional destination, added after the first release; older extensions omit
  // both and land in the Inbox. `folder` is a vault-relative path from GET
  // /folders, `vaultId` the id that listing returned. The server files the clip
  // only when both still match the open vault; otherwise it stays in the Inbox.
  folder: z.string().min(1).max(1024).optional(),
  vaultId: z.string().min(1).max(128).optional()
})

export type ArticleCaptureInput = z.infer<typeof ArticleCaptureSchema>
