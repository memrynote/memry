import { and, asc, eq, ne } from 'drizzle-orm'
import { extractedText } from '@memry/db-schema/index-schema'
import type { IndexDrizzleDb } from '@memry/db-schema/drizzle-db'

/**
 * The visible text of each HTML block a markdown note embeds, by file name.
 * The desktop app's file-text runner writes it; a vault it never opened has none.
 */
export function listHtmlBlockText(db: IndexDrizzleDb, noteId: string): string[] {
  return db
    .select({ text: extractedText.text })
    .from(extractedText)
    .where(
      and(
        eq(extractedText.noteId, noteId),
        eq(extractedText.method, 'html'),
        ne(extractedText.text, '')
      )
    )
    .orderBy(asc(extractedText.source), asc(extractedText.part))
    .all()
    .map((row) => row.text)
}
