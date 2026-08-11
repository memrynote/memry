import { eq } from 'drizzle-orm'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import type { CaptureSource } from '@memry/contracts/inbox-api'
import type { ArticleCapture } from '@memry/article-extract'
import { requireDatabase } from '../database'
import { generateId } from '../lib/id'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { publishProjectionEvent } from '../projections'
import { insertItemWithTags, emitCapturedAndSync } from './domain'
import { findDuplicateByUrl } from './duplicates'
import { downloadImage } from './metadata'
import { getItemAttachmentsDir, storeInboxAttachment } from './attachments'
import { parseDataUrl } from './parse-data-url'

const log = createLogger('Inbox:Ingest')

export interface IngestArticleCaptureInput extends ArticleCapture {
  itemId?: string
  itemType?: 'link' | 'clip' | 'pdf'
  tags?: string[]
  force?: boolean
}

function emitInboxEvent(channel: string, data: unknown): void {
  broadcastToAllWindows(channel, data)
}

function emitUpdated(itemId: string, changes: Record<string, unknown>): void {
  emitInboxEvent(InboxChannels.events.UPDATED, { id: itemId, changes })
  publishProjectionEvent({ type: 'inbox.upserted', itemId })
}

async function downloadHero(itemId: string, heroImage: string | undefined): Promise<string | null> {
  if (!heroImage) return null
  const name = await downloadImage(heroImage, getItemAttachmentsDir(itemId))
  return name ? `attachments/inbox/${itemId}/${name}` : null
}

export async function ingestArticleCapture(
  input: IngestArticleCaptureInput,
  source: CaptureSource
): Promise<{ itemId: string }> {
  const db = requireDatabase()

  // Enrich existing item (paste path).
  if (input.itemId) {
    const item = db.select().from(inboxItems).where(eq(inboxItems.id, input.itemId)).get()
    const existingMetadata =
      item?.metadata && typeof item.metadata === 'object'
        ? (item.metadata as Record<string, unknown>)
        : {}
    const thumbnailPath = await downloadHero(input.itemId, input.heroImage)
    const now = new Date().toISOString()
    db.update(inboxItems)
      .set({
        content: input.contentMarkdown,
        ...(thumbnailPath ? { thumbnailPath } : {}),
        modifiedAt: now,
        metadata: {
          ...existingMetadata,
          url: input.url,
          excerpt: input.excerpt,
          extractionStatus: input.extractionStatus,
          properties: input.properties
        }
      })
      .where(eq(inboxItems.id, input.itemId))
      .run()
    emitUpdated(input.itemId, { content: input.contentMarkdown })
    return { itemId: input.itemId }
  }

  // Dedup on URL unless force. Only matches active (unfiled, unarchived) items, so
  // re-capturing a URL you already filed into a folder creates a fresh inbox item.
  if (!input.force) {
    const existing = findDuplicateByUrl(input.url)
    if (existing) {
      return ingestArticleCapture({ ...input, itemId: existing.id }, source)
    }
  }

  // Create a new item (extension path).
  const id = generateId()
  const now = new Date().toISOString()
  const tags = input.tags ?? ['clippings']

  // Screenshot mode: decode the data URL into an inbox attachment and make the
  // image the note body. The extension sends contentMarkdown:'' for screenshots.
  let content = input.contentMarkdown
  let screenshotPath: string | null = null
  if (input.screenshotDataUrl) {
    const parsed = parseDataUrl(input.screenshotDataUrl)
    if (parsed) {
      const stored = await storeInboxAttachment(id, parsed.buffer, 'screenshot', parsed.mime)
      if (stored.success && stored.path) {
        screenshotPath = stored.path
        content = `![screenshot](${stored.path})`
      } else {
        log.warn('screenshot attachment failed', { itemId: id, error: stored.error })
      }
    }
  }

  // PDF mode: the extension fetched the tab's PDF and base64'd it. Decode into an
  // inbox attachment and file it as a `pdf` item — the same row shape the
  // drag-and-drop path produces, so the viewer and folder filing need no changes.
  // Any failure here degrades to a plain link item rather than losing the clip.
  let pdfPath: string | null = null
  let pdfMetadata: Record<string, unknown> = {}
  if (input.pdfDataUrl) {
    const parsed = parseDataUrl(input.pdfDataUrl)
    if (!parsed || parsed.mime !== 'application/pdf') {
      log.warn('pdf capture had a non-pdf data url', { itemId: id, mime: parsed?.mime })
    } else {
      const filename = input.pdfFilename ?? 'document.pdf'
      const stored = await storeInboxAttachment(id, parsed.buffer, filename, 'application/pdf')
      if (stored.success && stored.path) {
        pdfPath = stored.path
        pdfMetadata = {
          originalFilename: filename,
          fileSize: parsed.buffer.length,
          mimeType: 'application/pdf'
        }
      } else {
        log.warn('pdf attachment failed', { itemId: id, error: stored.error })
      }
    }
  }

  const thumbnailPath = screenshotPath ?? (await downloadHero(id, input.heroImage))
  const { row, tags: appliedTags } = insertItemWithTags(
    db,
    {
      id,
      type: input.itemType ?? (pdfPath ? 'pdf' : 'link'),
      title: input.properties.title,
      content: pdfPath ? null : content,
      sourceUrl: input.url,
      attachmentPath: pdfPath,
      thumbnailPath,
      createdAt: now,
      modifiedAt: now,
      processingStatus: 'complete',
      captureSource: source,
      metadata: {
        url: input.url,
        fetchStatus: 'complete',
        excerpt: input.excerpt,
        extractionStatus: input.extractionStatus,
        heroImage: input.heroImage,
        properties: input.properties,
        ...pdfMetadata
      }
    },
    tags
  )
  emitCapturedAndSync(row, appliedTags)
  log.info('ingested capture', { itemId: id, source, status: input.extractionStatus })
  return { itemId: id }
}
