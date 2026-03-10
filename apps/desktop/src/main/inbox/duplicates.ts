import { eq, and, isNull } from 'drizzle-orm'
import { createHash } from 'crypto'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import type { DuplicateMatch } from '@memry/contracts/inbox-api'
import { getDatabase } from '../database'
import { createLogger } from '../lib/logger'

const log = createLogger('Inbox:Duplicates')

const CONTENT_HASH_LENGTH = 500

function activeItemFilter() {
  return and(isNull(inboxItems.filedAt), isNull(inboxItems.archivedAt))
}

function contentHash(content: string): string {
  return createHash('sha256').update(content.slice(0, CONTENT_HASH_LENGTH)).digest('hex')
}

export function findDuplicateByUrl(url: string): DuplicateMatch | null {
  try {
    const db = getDatabase()
    const match = db
      .select({
        id: inboxItems.id,
        title: inboxItems.title,
        createdAt: inboxItems.createdAt
      })
      .from(inboxItems)
      .where(and(eq(inboxItems.sourceUrl, url), activeItemFilter()))
      .get()

    return match ?? null
  } catch (err) {
    log.warn('Duplicate URL check failed:', err)
    return null
  }
}

export function findDuplicateByContent(content: string): DuplicateMatch | null {
  if (!content || content.length < 20) return null

  try {
    const db = getDatabase()
    const targetHash = contentHash(content)

    const candidates = db
      .select({
        id: inboxItems.id,
        title: inboxItems.title,
        content: inboxItems.content,
        createdAt: inboxItems.createdAt
      })
      .from(inboxItems)
      .where(and(eq(inboxItems.type, 'note'), activeItemFilter()))
      .all()

    for (const candidate of candidates) {
      if (!candidate.content) continue
      if (contentHash(candidate.content) === targetHash) {
        return {
          id: candidate.id,
          title: candidate.title,
          createdAt: candidate.createdAt
        }
      }
    }

    return null
  } catch (err) {
    log.warn('Duplicate content check failed:', err)
    return null
  }
}
