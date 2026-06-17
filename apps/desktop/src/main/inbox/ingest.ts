import { BrowserWindow } from 'electron'
import { eq } from 'drizzle-orm'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import type { CaptureSource } from '@memry/contracts/inbox-api'
import type { ArticleCapture } from '@memry/article-extract'
import { requireDatabase } from '../database'
import { generateId } from '../lib/id'
import { createLogger } from '../lib/logger'
import { publishProjectionEvent } from '../projections'
import { insertItemWithTags, emitCapturedAndSync } from './domain'
import { downloadImage } from './metadata'
import { getItemAttachmentsDir } from './attachments'

const log = createLogger('Inbox:Ingest')

export interface IngestArticleCaptureInput extends ArticleCapture {
  itemId?: string
  itemType?: 'link' | 'clip'
  tags?: string[]
  force?: boolean
}

function emitInboxEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
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

  // Dedup on URL unless force.
  if (!input.force) {
    const existing = db.select().from(inboxItems).where(eq(inboxItems.sourceUrl, input.url)).get()
    if (existing) {
      return ingestArticleCapture({ ...input, itemId: existing.id }, source)
    }
  }

  // Create a new item (extension path).
  const id = generateId()
  const now = new Date().toISOString()
  const tags = input.tags ?? input.properties.tags ?? []
  const thumbnailPath = await downloadHero(id, input.heroImage)
  const { row, tags: appliedTags } = insertItemWithTags(
    db,
    {
      id,
      type: input.itemType ?? 'link',
      title: input.properties.title,
      content: input.contentMarkdown,
      sourceUrl: input.url,
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
        properties: input.properties
      }
    },
    tags
  )
  emitCapturedAndSync(row, appliedTags)
  log.info('ingested capture', { itemId: id, source, status: input.extractionStatus })
  return { itemId: id }
}
