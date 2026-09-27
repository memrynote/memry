import { NoteIconDisplay } from '@/lib/render-note-icon'
import { FileAudio, FileImage, FilePdf, FileVideo, PenTool } from '@/lib/icons'
import type { FileType } from '@memry/shared/file-types'
import type { RelatedItemInfo, RelatedRef } from './use-related-item-info'

const NoteIcon = ({ color }: { color: string }): React.JSX.Element => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    className="shrink-0"
    style={{ color }}
  >
    <rect x="2" y="1.5" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
    <path d="M4.5 4.5h5M4.5 7h5M4.5 9.5h3" stroke="currentColor" strokeLinecap="round" />
  </svg>
)

const RelatedFileIcon = ({
  fileType,
  color
}: {
  fileType: FileType
  color: string
}): React.JSX.Element => {
  const className = 'size-3.5 shrink-0 text-text-tertiary'

  switch (fileType) {
    case 'pdf':
      return <FilePdf className={className} aria-hidden="true" />
    case 'image':
      return <FileImage className={className} aria-hidden="true" />
    case 'audio':
      return <FileAudio className={className} aria-hidden="true" />
    case 'video':
      return <FileVideo className={className} aria-hidden="true" />
    case 'markdown':
      return <NoteIcon color={color} />
  }
}

/** A related note, file or canvas, drawn the way the rest of the app draws it. */
export const RelatedIcon = ({
  kind,
  info,
  projectColor
}: {
  kind: RelatedRef['kind']
  info?: RelatedItemInfo
  projectColor: string
}): React.JSX.Element => {
  if (kind === 'canvas') {
    const icon = info?.kind === 'canvas' ? info.icon : null
    return icon ? (
      <NoteIconDisplay value={icon} className="size-3.5 shrink-0 text-[13px] leading-3.5" />
    ) : (
      <PenTool className="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
    )
  }
  const emoji = info?.kind === 'note' ? info.emoji : null
  return emoji ? (
    <span className="size-3.5 text-center text-[13px] leading-3.5 shrink-0">{emoji}</span>
  ) : (
    <RelatedFileIcon
      fileType={info?.kind === 'note' ? info.fileType : 'markdown'}
      color={projectColor}
    />
  )
}
