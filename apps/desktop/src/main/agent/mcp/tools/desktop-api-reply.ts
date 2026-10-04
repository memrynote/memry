import type { NoteCache } from '@memry/db-schema/schema/notes-cache'
import type { NoteFileType } from '@memry/contracts/search-api'

const DESKTOP_API_REPLY_MAX_CHARS = 100 * 1024

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
  totalChars: number
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

function truncatedReply(text: string, end: number): TruncatedDesktopApiReply {
  return {
    truncated: true,
    totalChars: text.length,
    message:
      `Reply cut at ${end} of ${text.length} characters. ` +
      'partial holds the start of the JSON reply. Narrow the request to get the rest.',
    partial: text.slice(0, end)
  }
}

export function shapeDesktopApiReply(
  data: unknown,
  fileRowOf: (id: string) => FileRow | undefined
): unknown {
  const shaped = withoutFileBodies(data, fileRowOf)
  const text = JSON.stringify(shaped) ?? ''
  if (text.length <= DESKTOP_API_REPLY_MAX_CHARS) return shaped

  // `partial` is escaped again when the reply is serialized, so the cut point
  // shrinks until the whole serialized reply fits.
  let end = DESKTOP_API_REPLY_MAX_CHARS
  let reply = truncatedReply(text, end)
  let replyChars = JSON.stringify(reply).length
  while (replyChars > DESKTOP_API_REPLY_MAX_CHARS) {
    end = Math.min(end - 1, Math.floor((end * DESKTOP_API_REPLY_MAX_CHARS) / replyChars))
    reply = truncatedReply(text, end)
    replyChars = JSON.stringify(reply).length
  }
  return reply
}
