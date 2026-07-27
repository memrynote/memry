import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { ProjectLinkedFile } from '@memry/rpc/tasks'
import { HubRow } from './hub-row'
import { fileIconFor, formatFileSize } from './file-icon'

interface FileRowProps {
  file: ProjectLinkedFile
  onOpen: (fileId: string) => void
}

export const FileRow = ({ file, onOpen }: FileRowProps): React.JSX.Element => {
  const { t, i18n } = useT('tasks')
  const Icon = fileIconFor(file.fileType, file.title)
  const size = formatFileSize(file.fileSize)

  const modified = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }).format(
        new Date(file.modifiedAt)
      ),
    [file.modifiedAt, i18n.language]
  )

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
          <span>{modified}</span>
        </>
      }
    >
      <span className="truncate text-sm">{file.title}</span>
    </HubRow>
  )
}
