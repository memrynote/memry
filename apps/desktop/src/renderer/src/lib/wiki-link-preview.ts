import { notesService, type WikiLinkPreview } from '@/services/notes-service'
import { splitWikiTarget } from '@memry/shared/wiki-target'

/**
 * The note a wiki link points at, as the hover card and a link card show it.
 *
 * Split first, raw second: the same order `resolveWikiLink` uses, so what is
 * previewed is the note a click would open. Without it a `[[Note#Heading]]`
 * looked up `Note#Heading`, found nothing, and the link silently had no preview.
 */
export async function previewWikiLinkTarget(target: string): Promise<WikiLinkPreview | null> {
  const { note, heading } = splitWikiTarget(target)
  if (heading !== null && note) {
    return (await notesService.previewByTitle(note)) ?? (await notesService.previewByTitle(target))
  }
  return notesService.previewByTitle(target)
}
