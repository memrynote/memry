import { memo, useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { useLargeFileSession } from '@/hooks/use-large-file-session'
import { LargeFileNotice, largeFileReasonArgs } from './large-file-notice'
import type { NoteLargeFileReason } from '@memry/contracts/notes-api'

/**
 * Row height, in px. Fixed on purpose: the virtualizer addresses lines by
 * index, so a wrapped or measured row would put every offset below it out by
 * however much it grew.
 */
export const LARGE_FILE_LINE_HEIGHT = 22

/** Rows rendered either side of the viewport, so scrolling stays ahead of IPC. */
const OVERSCAN_ROWS = 24

export interface LargeFileViewerProps {
  noteId: string
  /** Which bound put the file out of note class, from the classifier. */
  reason: NoteLargeFileReason | null | undefined
  /** Measured size the reason refers to, when the main process reported one. */
  measuredBytes?: number | null
  className?: string
}

/**
 * Read-only view of a large-file-class vault file.
 *
 * Replaces the editor for anything the BlockNote parser cannot be asked to
 * handle. There is no editing surface here at all: no Y.Doc, no CRDT, nothing
 * that could write back. The badge says so, permanently, because the failure
 * this feature exists to prevent is the *silent* one — a file that looks
 * editable, is edited, and never syncs.
 */
export const LargeFileViewer = memo(function LargeFileViewer({
  noteId,
  reason,
  measuredBytes,
  className
}: LargeFileViewerProps) {
  const { t } = useT('notes')
  const { state, getLine, isTruncated, ensureRange } = useLargeFileSession(noteId)
  const scrollRef = useRef<HTMLDivElement>(null)

  const lineCount = state.status === 'ready' ? state.lineCount : 0
  const virtualizer = useVirtualizer({
    count: lineCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LARGE_FILE_LINE_HEIGHT,
    overscan: OVERSCAN_ROWS
  })

  const rows = virtualizer.getVirtualItems()
  const firstRow = rows[0]?.index ?? 0
  const lastRow = rows[rows.length - 1]?.index ?? 0

  useEffect(() => {
    if (lineCount > 0) ensureRange(firstRow, lastRow)
  }, [ensureRange, firstRow, lastRow, lineCount])

  if (state.status === 'too-large') {
    return (
      <div
        data-testid="large-file-viewer"
        className={cn('flex h-full min-h-[60vh] flex-col', className)}
      >
        <LargeFileNotice
          ceiling="viewer"
          reason="file-bytes"
          measuredBytes={state.fileBytes}
          maxBytes={state.maxBytes}
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void window.api.notes.openExternal(noteId)}
              >
                {t('page.largeFile.openExternally')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.api.notes.revealInFinder(noteId)}
              >
                {t('page.largeFile.revealInFolder')}
              </Button>
            </>
          }
        />
      </div>
    )
  }

  return (
    <div
      data-testid="large-file-viewer"
      className={cn('flex h-full min-h-[60vh] flex-col', className)}
    >
      <ViewerHeader
        reason={reason}
        measuredBytes={measuredBytes}
        lineCount={state.status === 'ready' ? state.lineCount : null}
      />

      {state.status === 'missing' && <CenteredMessage text={t('page.largeFile.viewer.missing')} />}
      {state.status === 'error' && <CenteredMessage text={t('page.largeFile.viewer.failed')} />}

      {(state.status === 'opening' || state.status === 'indexing') && (
        <ScanProgress
          bytesScanned={state.status === 'indexing' ? state.bytesScanned : 0}
          fileBytes={state.status === 'indexing' ? state.fileBytes : (measuredBytes ?? 0)}
        />
      )}

      {state.status === 'ready' && lineCount === 0 && (
        <CenteredMessage text={t('page.largeFile.viewer.empty')} />
      )}

      {state.status === 'ready' && lineCount > 0 && (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div className="relative w-max min-w-full" style={{ height: virtualizer.getTotalSize() }}>
            {rows.map((row) => (
              <LineRow
                key={row.key}
                line={row.index}
                offset={row.start}
                text={getLine(row.index)}
                truncated={isTruncated(row.index)}
                truncatedLabel={t('page.largeFile.viewer.lineTruncated')}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
})

function ViewerHeader({
  reason,
  measuredBytes,
  lineCount
}: {
  reason: NoteLargeFileReason | null | undefined
  measuredBytes?: number | null
  lineCount: number | null
}): React.JSX.Element {
  const { t } = useT('notes')
  const { key, limit } = largeFileReasonArgs(reason)

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2">
      <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground">
        {t('page.largeFile.badge')}
      </span>
      {typeof measuredBytes === 'number' && (
        <span className="text-xs text-muted-foreground">
          {t(`page.largeFile.reason.${key}`, {
            size: formatBytes(measuredBytes),
            limit: formatBytes(limit)
          })}
        </span>
      )}
      {lineCount !== null && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('page.largeFile.viewer.lines', { count: lineCount })}
        </span>
      )}
    </div>
  )
}

function ScanProgress({
  bytesScanned,
  fileBytes
}: {
  bytesScanned: number
  fileBytes: number
}): React.JSX.Element {
  const { t } = useT('notes')
  const percent = fileBytes > 0 ? Math.min(100, Math.round((bytesScanned / fileBytes) * 100)) : 0

  return (
    <div className="flex flex-1 items-center justify-center px-8 py-12">
      <div className="w-full max-w-sm text-start">
        <p className="text-sm text-foreground">
          {t('page.largeFile.viewer.preparing', { size: formatBytes(fileBytes) })}
        </p>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full bg-muted-foreground/60 transition-[width] duration-200 ease-out motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t('page.largeFile.viewer.preparingHint')}
        </p>
      </div>
    </div>
  )
}

function CenteredMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center px-8 py-12">
      <p className="max-w-md text-sm text-muted-foreground text-start">{text}</p>
    </div>
  )
}

const LineRow = memo(function LineRow({
  line,
  offset,
  text,
  truncated,
  truncatedLabel
}: {
  line: number
  offset: number
  text: string | undefined
  truncated: boolean
  truncatedLabel: string
}) {
  return (
    <div
      className="absolute top-0 start-0 flex w-max min-w-full items-center font-mono text-xs"
      style={{ height: LARGE_FILE_LINE_HEIGHT, transform: `translateY(${offset}px)` }}
    >
      <span className="w-16 shrink-0 select-none border-e border-border pe-3 text-end text-muted-foreground tabular-nums">
        {line + 1}
      </span>
      <span className="ps-3 whitespace-pre text-foreground">{text ?? ''}</span>
      {truncated && (
        <span className="ms-2 shrink-0 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground">
          {truncatedLabel}
        </span>
      )}
    </div>
  )
})

export default LargeFileViewer
