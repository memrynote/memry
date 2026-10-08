import type { NoteCache } from '@memry/db-schema/schema/notes-cache'
import type { AgentMcpDesktopOperation } from '@memry/contracts/agent-mcp-channels'
import type { NoteFileType } from '@memry/contracts/search-api'

import type { ReplyCap } from '../reply-cap'

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

// The one place that tells an agent where a filed file's content can be read.
const CONTENT_ACCESS: Record<FiledFileType, string> = {
  image:
    'The desktop API returns metadata only for image files. vault_view_file with this id shows the image itself. vault_read_note with this id returns the text read from the image (OCR).',
  pdf: 'The desktop API returns metadata only for PDF files. vault_read_note with this id returns the text read from the PDF, page by page. vault_view_file with this id and a page number shows that page as an image.',
  audio: 'The desktop API returns metadata only for audio files.',
  video: 'The desktop API returns metadata only for video files.'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}

// What a cut reply tells the agent to call instead, for operations without a limit argument.
const CUT_ADVICE = new Map<string, string>([
  ['calendar.getRange', 'Call calendar.getRange again with a shorter date range.'],
  [
    'calendar.listEvents',
    'calendar.listEvents returns every event; call calendar.getRange with a date range instead.'
  ]
] satisfies Array<[AgentMcpDesktopOperation, string]>)

const DEFAULT_CUT_ADVICE =
  'Call an operation that returns less, such as a list with a smaller limit, or ' +
  'vault_read_note for a note body.'

export const DESKTOP_API_REPLY_CAP: ReplyCap = {
  maxBytes: 100 * 1024,
  advice: (input) =>
    (isPlainObject(input) && typeof input.operation === 'string'
      ? CUT_ADVICE.get(input.operation)
      : undefined) ?? DEFAULT_CUT_ADVICE
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
