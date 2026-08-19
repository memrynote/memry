import { memo, type ReactNode } from 'react'
import { FileWarning } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format'
import { useT } from '@memry/i18n/renderer'
import { NOTE_MAX_BYTES, NOTE_MAX_BLOCK_BYTES } from '@memry/shared/markdown-class'
import type { NoteLargeFileReason } from '@memry/contracts/notes-api'

/**
 * Which limit a large-file reason refers to, and the copy key that names it.
 * Shared with the viewer's header so both quote the same bound.
 */
export function largeFileReasonArgs(reason: NoteLargeFileReason | null | undefined): {
  key: 'fileBytes' | 'blockBytes'
  limit: number
} {
  return reason === 'block-bytes'
    ? { key: 'blockBytes', limit: NOTE_MAX_BLOCK_BYTES }
    : { key: 'fileBytes', limit: NOTE_MAX_BYTES }
}

export interface LargeFileNoticeProps {
  /** Which bound put the file out of note class. */
  reason: NoteLargeFileReason | null | undefined
  /** Measured size the reason refers to, when the main process reported one. */
  measuredBytes?: number | null
  /**
   * Which ceiling was hit. `'note'` — too big to *edit*, and the read-only
   * viewer opens instead. `'viewer'` — too big to open at all.
   */
  ceiling?: 'note' | 'viewer'
  /** The viewer ceiling, as the main process reported it. Only for `'viewer'`. */
  maxBytes?: number
  /** Ways out of a file that cannot be opened here at all. */
  actions?: ReactNode
  className?: string
}

/**
 * Shown in place of the file's contents when Memry will not render them.
 *
 * The point is that the refusal reads as deliberate. An empty editor looks like
 * data loss, and a hang looks like a crash — so this names the file's size, the
 * limit it passed, and says the bytes on disk are untouched.
 */
export const LargeFileNotice = memo(function LargeFileNotice({
  reason,
  measuredBytes,
  ceiling = 'note',
  maxBytes,
  actions,
  className
}: LargeFileNoticeProps) {
  const { t } = useT('notes')

  const isViewerCeiling = ceiling === 'viewer'
  const { key: reasonKey, limit: noteLimit } = largeFileReasonArgs(reason)
  const limit = isViewerCeiling ? (maxBytes ?? 0) : noteLimit

  return (
    <div
      className={cn('flex h-full flex-col items-center justify-center px-8 py-12', className)}
      data-testid="large-file-notice"
    >
      <div className="max-w-md rounded-lg border border-border bg-muted/20 p-6 text-start">
        <div className="flex items-center gap-3">
          <FileWarning className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-base font-medium text-foreground">
            {t(isViewerCeiling ? 'page.largeFile.tooLarge.title' : 'page.largeFile.title')}
          </h2>
        </div>

        {!isViewerCeiling && (
          <span className="mt-3 inline-block rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground">
            {t('page.largeFile.badge')}
          </span>
        )}

        {typeof measuredBytes === 'number' && (
          <p className="mt-3 text-sm text-muted-foreground">
            {isViewerCeiling
              ? t('page.largeFile.tooLarge.reason', {
                  size: formatBytes(measuredBytes),
                  limit: formatBytes(limit)
                })
              : t(`page.largeFile.reason.${reasonKey}`, {
                  size: formatBytes(measuredBytes),
                  limit: formatBytes(limit)
                })}
          </p>
        )}

        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            isViewerCeiling ? 'page.largeFile.tooLarge.explanation' : 'page.largeFile.explanation'
          )}
        </p>

        {actions && <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
})

export default LargeFileNotice
