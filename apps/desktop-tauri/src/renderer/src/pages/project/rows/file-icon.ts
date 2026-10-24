import { File, FileCode, FileText, Image, Music, Video } from '@/lib/icons'

type IconComponent = typeof File

const BY_FILE_TYPE: Record<string, IconComponent> = {
  pdf: FileText,
  image: Image,
  audio: Music,
  video: Video
}

const BY_EXTENSION: Record<string, IconComponent> = {
  md: FileCode,
  markdown: FileCode,
  txt: FileText,
  csv: FileText,
  json: FileCode
}

/**
 * Pick a glyph for a linked file row.
 *
 * `fileType` is the coarse kind the indexer assigned; the extension refines it
 * for the text-ish kinds that all share `markdown`, so a `.md` spec and a `.csv`
 * export do not look identical in the list.
 */
export function fileIconFor(fileType: string, title: string): IconComponent {
  const byType = BY_FILE_TYPE[fileType]
  if (byType) return byType

  const extension = title.includes('.') ? title.split('.').pop()?.toLowerCase() : undefined
  if (extension && BY_EXTENSION[extension]) return BY_EXTENSION[extension]

  return File
}

/** Human-readable file size, or null when the indexer never recorded one. */
export function formatFileSize(bytes: number | null): string | null {
  if (bytes == null) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
