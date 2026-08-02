import { useT } from '@memry/i18n/renderer'
import type { ProjectLinkedFile } from '@memry/rpc/tasks'
import { HubRow, HUB_ROW_TITLE } from './hub-row'
import { fileIconFor, formatFileSize } from './file-icon'
import { useRelativeTime } from '../use-relative-time'

interface FileRowProps {
  file: ProjectLinkedFile
  onOpen: (fileId: string) => void
}

export const FileRow = ({ file, onOpen }: FileRowProps): React.JSX.Element => {
  const { t, i18n } = useT('tasks')
  const Icon = fileIconFor(file.fileType, file.title)
  const size = formatFileSize(file.fileSize)

  // Relative, like the Inbox — under a "Today"/"Older" heading an absolute date
  // only repeats what the section already said.
  const modified = useRelativeTime(file.modifiedAt, i18n.language)

  return (
    <HubRow
      leading={<Icon className="size-4 text-muted-foreground" aria-hidden="true" />}
      onOpen={() => onOpen(file.id)}
      openLabel={t('projectHub.rows.openFile', { title: file.title })}
      trailing={
        <>
          {size ? (
            <span className="rounded-full border border-border px-1.5 py-0.5 text-[11px] leading-none">
              {size}
            </span>
          ) : null}
          <span className="w-9 shrink-0 text-end tabular-nums">{modified}</span>
        </>
      }
    >
      <span className={HUB_ROW_TITLE}>{file.title}</span>
    </HubRow>
  )
}
