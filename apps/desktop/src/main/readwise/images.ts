import { createHash } from 'node:crypto'
import { createLogger } from '../lib/logger'
import { getAttachmentRef, listNoteAttachments } from '../vault/attachments'
import { getVaultRoot } from '../vault/notes-io'
import { downloadAttachmentFromUrl, type RemoteFetch } from '../vault/remote-attachment'

const log = createLogger('ReadwiseImages')

/** `rw-<hash>` for an image URL (D14): the name an image is stored under, so it can be found again. */
export function imageFileStem(url: string): string {
  return `rw-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`
}

/**
 * Saves each remote image as an attachment of the note, named from its URL
 * (D14). A file that is already there is reused, so an unchanged book downloads
 * nothing and a takeover finds the files that synced with the notes. A failed
 * download leaves that URL out of the map and logs why. The map goes to
 * `planNote` / `planAppend`, which leave a URL it lacks out of the section.
 */
export async function resolveImages(
  noteId: string,
  notePath: string,
  urls: readonly string[],
  fetch: RemoteFetch
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()
  if (urls.length === 0) return resolved

  const existing = await listNoteAttachments(noteId)
  for (const url of urls) {
    const stem = imageFileStem(url)
    const present = existing.find((file) => file.filename.startsWith(`${stem}.`))
    if (present) {
      resolved.set(url, getAttachmentRef(getVaultRoot(), noteId, present.filename, notePath))
      continue
    }
    if (!/^https?:\/\//i.test(url)) {
      log.warn('Skipping a Readwise image that is not an http(s) URL', { noteId })
      continue
    }
    const saved = await downloadAttachmentFromUrl({ noteId, url }, { fetch }, { fileStem: stem })
    if (saved.ok) resolved.set(url, saved.ref)
    else
      log.warn('A Readwise image could not be saved; it stays out of the note', {
        noteId,
        reason: saved.reason
      })
  }
  return resolved
}
