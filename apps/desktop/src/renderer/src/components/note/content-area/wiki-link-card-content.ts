/**
 * What a link card shows of the note it points at (#2845): an icon, a line of
 * preview text and a cover. Pure, so the choices (description before body,
 * which icons are plain emoji) are testable without a note or an IPC.
 */

import { coverWashGradient, parseCoverValue } from '@memry/shared/cover-image'
import { isCustomIconValue, isIconValue } from '@/components/note/note-title/emoji-icon-utils'
import { resolveNoteRelativeUrl } from '@/lib/resolve-note-relative-url'
import type { WikiLinkPreview } from '@/services/notes-service'

export type WikiLinkCardCover = { kind: 'image'; url: string } | { kind: 'wash'; gradient: string }

export interface WikiLinkCardContent {
  /** A plain emoji; null draws the default document icon. */
  icon: string | null
  /** The note's `description` property, else the plain text of its opening. */
  text: string | null
  cover: WikiLinkCardCover | null
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function wikiLinkCardContent(
  preview: WikiLinkPreview,
  vaultPath: string | null
): WikiLinkCardContent {
  // Library and custom icons are drawn by React components; a card made of raw
  // DOM keeps to the glyph a plain emoji is.
  const emoji = nonEmpty(preview.emoji)
  const icon = emoji && !isIconValue(emoji) && !isCustomIconValue(emoji) ? emoji : null

  const parsedCover = parseCoverValue(preview.cover)
  let cover: WikiLinkCardCover | null = null
  if (parsedCover?.kind === 'wash') {
    cover = { kind: 'wash', gradient: coverWashGradient(parsedCover.id) }
  } else if (parsedCover) {
    cover = {
      kind: 'image',
      url: resolveNoteRelativeUrl(parsedCover.ref, preview.path, vaultPath, preview.id)
    }
  }

  // Never `snippet`: it is the note's raw markdown on one line, with the fences,
  // column markers and tags the editor does not draw.
  return { icon, text: nonEmpty(preview.description) ?? nonEmpty(preview.bodyText), cover }
}
