/**
 * Copy an image at a public URL into a note's attachments folder.
 *
 * The bytes land in the vault like any other attachment, so a cover picked
 * from a link keeps working offline, on the next device, and after the page
 * behind the link goes away. Nothing here ever leaves a remote URL in a note.
 *
 * @module vault/remote-attachment
 */

import type {
  DownloadAttachmentFromUrlInput,
  DownloadAttachmentFromUrlResult
} from '@memry/contracts/notes-api'

import { createLogger } from '../lib/logger'
import { emitNoteAttachmentSaved } from '../notes/runtime-effects'
import { saveAttachment } from './attachments'

const logger = createLogger('RemoteAttachment')

/** Big enough for a full-resolution photo, small enough that a mistake is cheap. */
const MAX_BYTES = 25 * 1024 * 1024

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif'
}

/**
 * The slice of `fetch` this module uses, declared structurally so it never
 * imports `electron` and stays runnable under plain Node in tests. The handler
 * passes `net.fetch`.
 */
export interface RemoteFetchResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

export type RemoteFetch = (url: string) => Promise<RemoteFetchResponse>

export interface RemoteAttachmentDeps {
  fetch: RemoteFetch
}

function mimeTypeOf(response: RemoteFetchResponse): string | null {
  const raw = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
  return raw ? raw : null
}

/** The stored name, taken from the URL's own last segment when it has one. */
function filenameFor(url: string, extension: string): string {
  let candidate = ''
  try {
    candidate = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  } catch {
    candidate = ''
  }
  const base = candidate
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base.slice(0, 64) || 'linked-image'}.${extension}`
}

export async function downloadAttachmentFromUrl(
  input: DownloadAttachmentFromUrlInput,
  deps: RemoteAttachmentDeps
): Promise<DownloadAttachmentFromUrlResult> {
  let response: RemoteFetchResponse
  try {
    response = await deps.fetch(input.url)
  } catch (error) {
    logger.warn('A linked image could not be fetched', { error })
    return { ok: false, reason: 'offline' }
  }

  if (!response.ok) {
    logger.warn('A linked image answered with an error status', { status: response.status })
    return { ok: false, reason: 'failed' }
  }

  // A link to the page showing a photo answers with HTML, which is the common
  // paste. Refusing on the declared type keeps that out of the vault.
  const mimeType = mimeTypeOf(response)
  const extension = mimeType ? EXTENSION_BY_MIME[mimeType] : undefined
  if (!extension) return { ok: false, reason: 'not-an-image' }

  const declaredLength = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    return { ok: false, reason: 'too-large' }
  }

  let bytes: Buffer
  try {
    bytes = Buffer.from(new Uint8Array(await response.arrayBuffer()))
  } catch (error) {
    logger.error('A linked image body could not be read', { error })
    return { ok: false, reason: 'failed' }
  }
  // Checked again on the real body: `Content-Length` is a claim, not a limit.
  if (bytes.byteLength > MAX_BYTES) return { ok: false, reason: 'too-large' }

  const saved = await saveAttachment(input.noteId, bytes, filenameFor(input.url, extension))
  if (!saved.success || !saved.path) {
    logger.error('A linked image could not be written to the vault', {
      noteId: input.noteId,
      error: saved.error
    })
    return { ok: false, reason: 'write-failed' }
  }

  // `saveAttachment` falls back to an absolute `memry-file://` URL when the note
  // is not indexed yet. That ref names this machine's vault path, and a cover is
  // stored in frontmatter that syncs, so accepting it would hand every other
  // device a broken cover.
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(saved.path) || saved.path.startsWith('/')) {
    logger.error('A linked image resolved to a non-portable ref', { noteId: input.noteId })
    return { ok: false, reason: 'write-failed' }
  }

  if (saved.diskPath) {
    try {
      emitNoteAttachmentSaved(input.noteId, saved.diskPath)
    } catch (error) {
      logger.warn('Linked image sync emit failed after local save', {
        noteId: input.noteId,
        error
      })
    }
  }

  return { ok: true, ref: saved.path }
}
