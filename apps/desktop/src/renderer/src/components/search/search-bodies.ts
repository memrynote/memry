import type { SearchResultItem } from '@memry/contracts/search-api'
import { notesService } from '@/services/notes-service'
import { journalService } from '@/services/journal-service'

/** Notes and journal days: the results whose body can be searched for occurrences. */
export function hasBody(item: SearchResultItem): boolean {
  const meta = item.metadata
  if (meta.type === 'journal') return true
  return meta.type === 'note' && (!meta.fileType || meta.fileType === 'markdown')
}

/** The markdown body behind a result, or null when it has none to read. */
export async function loadBodyMarkdown(item: SearchResultItem): Promise<string | null> {
  const meta = item.metadata
  if (meta.type === 'note') {
    if (meta.fileType && meta.fileType !== 'markdown') return null
    const note = await notesService.get(item.id)
    return note && !note.contentOmitted ? note.content : null
  }
  if (meta.type === 'journal') {
    const entry = await journalService.getEntry(meta.date)
    return entry ? entry.content : null
  }
  return null
}
