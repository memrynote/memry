import type { NoteCache } from '@memry/db-schema/schema/notes-cache'
import type { NoteFileType } from '@memry/contracts/search-api'

const DESKTOP_API_REPLY_MAX_BYTES = 100 * 1024

type FiledFileType = Exclude<NoteFileType, 'markdown'>

type FileRow = Pick<
  NoteCache,
  'id' | 'path' | 'title' | 'fileType' | 'mimeType' | 'fileSize' | 'createdAt' | 'modifiedAt'
>

// `notes.get` reads a filed file off disk as text, so a note object for one
// carries the file's bytes decoded as UTF-8 in `content` (#2623).
interface FiledFileMetadata {
  id: string
  path: string
  title: string
  fileType: FiledFileType
  mimeType: string | null
  fileSize: number | null
  created: string
  modified: string
  contentOmitted: true
  contentAccess: string
}

interface TruncatedDesktopApiReply {
  truncated: true
  totalBytes: number
  message: string
  partial: string
}

const CONTENT_ACCESS: Record<FiledFileType, string> = {
  image:
    'The desktop API returns metadata only for image files. Look at an image with the vision tool.',
  pdf: 'The desktop API returns metadata only for PDF files. Read a PDF through its extracted text.',
  audio: 'The desktop API returns metadata only for audio files.',
  video: 'The desktop API returns metadata only for video files.'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}

function filedFileMetadata(row: FileRow, fileType: FiledFileType): FiledFileMetadata {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    fileType,
    mimeType: row.mimeType ?? null,
    fileSize: row.fileSize ?? null,
    created: row.createdAt,
    modified: row.modifiedAt,
    contentOmitted: true,
    contentAccess: CONTENT_ACCESS[fileType]
  }
}

function withoutFileBodies(
  value: unknown,
  fileRowOf: (id: string) => FileRow | undefined
): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutFileBodies(item, fileRowOf))
  if (!isPlainObject(value)) return value

  if (typeof value.id === 'string' && typeof value.content === 'string') {
    const row = fileRowOf(value.id)
    const fileType = row?.fileType ?? 'markdown'
    if (row && fileType !== 'markdown') return filedFileMetadata(row, fileType)
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, withoutFileBodies(entry, fileRowOf)])
  )
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function truncatedReply(text: string, totalBytes: number, end: number): TruncatedDesktopApiReply {
  const partial = text.slice(0, /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) ? end - 1 : end)
  return {
    truncated: true,
    totalBytes,
    message:
      `Reply cut at ${utf8Bytes(partial)} of ${totalBytes} bytes. ` +
      'partial holds the start of the JSON reply and is not valid JSON on its own. ' +
      'The rest is not returned. Call an operation that returns less, such as a list with a ' +
      'smaller limit, or vault_read_note for a note body.',
    partial
  }
}

export function shapeDesktopApiReply(
  data: unknown,
  fileRowOf: (id: string) => FileRow | undefined
): unknown {
  const shaped = withoutFileBodies(data, fileRowOf)
  const text = JSON.stringify(shaped) ?? ''
  const totalBytes = utf8Bytes(text)
  if (totalBytes <= DESKTOP_API_REPLY_MAX_BYTES) return shaped

  // `partial` is escaped again when the reply is serialized, so the cut point
  // shrinks until the whole serialized reply fits.
  let end = Math.min(text.length, DESKTOP_API_REPLY_MAX_BYTES)
  let reply = truncatedReply(text, totalBytes, end)
  let replyBytes = utf8Bytes(JSON.stringify(reply))
  while (replyBytes > DESKTOP_API_REPLY_MAX_BYTES) {
    end = Math.min(end - 1, Math.floor((end * DESKTOP_API_REPLY_MAX_BYTES) / replyBytes))
    reply = truncatedReply(text, totalBytes, end)
    replyBytes = utf8Bytes(JSON.stringify(reply))
  }
  return reply
}
