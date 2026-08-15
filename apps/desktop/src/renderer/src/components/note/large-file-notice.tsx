import { memo } from 'react'
import { FileWarning } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format'
import { useT } from '@memry/i18n/renderer'
import { NOTE_MAX_BYTES, NOTE_MAX_BLOCK_BYTES } from '@memry/shared/markdown-class'
import type { NoteLargeFileReason } from '@memry/contracts/notes-api'

export interface LargeFileNoticeProps {
  /** Which bound put the file out of note class. */
  reason: NoteLargeFileReason | null | undefined
  /** Measured size the reason refers to, when the main process reported one. */
  measuredBytes?: number | null
  className?: string
}

/**
 * Shown in place of the editor for a large-file-class file.
 *
 * The point is that the refusal reads as deliberate. An empty editor looks like
 * data loss, and a hang looks like a crash — so this names the file's size, the
 * limit it passed, and says the bytes on disk are untouched.
 */
export const LargeFileNotice = memo(function LargeFileNotice({
  reason,
  measuredBytes,
  className
}: LargeFileNoticeProps) {
  const { t } = useT('notes')

  const limit = reason === 'block-bytes' ? NOTE_MAX_BLOCK_BYTES : NOTE_MAX_BYTES
  const reasonKey = reason === 'block-bytes' ? 'blockBytes' : 'fileBytes'

  return (
    <div
      className={cn('flex h-full flex-col items-center justify-center px-8 py-12', className)}
      data-testid="large-file-notice"
    >
      <div className="max-w-md rounded-lg border border-border bg-muted/20 p-6 text-start">
        <div className="flex items-center gap-3">
          <FileWarning className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-base font-medium text-foreground">{t('page.largeFile.title')}</h2>
        </div>

        <span className="mt-3 inline-block rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground">
          {t('page.largeFile.badge')}
        </span>

        {typeof measuredBytes === 'number' && (
          <p className="mt-3 text-sm text-muted-foreground">
            {t(`page.largeFile.reason.${reasonKey}`, {
              size: formatBytes(measuredBytes),
              limit: formatBytes(limit)
            })}
          </p>
        )}

        <p className="mt-2 text-sm text-muted-foreground">{t('page.largeFile.explanation')}</p>
      </div>
    </div>
  )
})

export default LargeFileNotice
