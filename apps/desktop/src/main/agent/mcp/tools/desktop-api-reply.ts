import type { NoteCache } from '@memry/db-schema/schema/notes-cache'
import type { NoteFileType } from '@memry/contracts/search-api'

export const DESKTOP_API_REPLY_MAX_BYTES = 100 * 1024

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

// FB-002 (#2605) and FB-001 (#2604) change the image and pdf rows to name
// their tools once those tools ship.
const CONTENT_ACCESS: Record<FiledFileType, string> = {
  image:
    'The desktop API returns metadata only for image files. Viewing an image is not available yet.',
  pdf: 'The desktop API returns metadata only for PDF files. Reading PDF text is not available yet.',
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

export function withoutFileBodies(
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
