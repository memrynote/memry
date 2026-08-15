import { memo, useEffect, useRef, useState, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { FindBar } from '@/components/find-bar/find-bar'
import { useLargeFileSession } from '@/hooks/use-large-file-session'
import { useLargeFileSearch, type LargeFileSearch } from '@/hooks/use-large-file-search'
import { LargeFileNotice, largeFileReasonArgs } from './large-file-notice'
import type { NoteLargeFileReason } from '@memry/contracts/notes-api'

/**
 * Starting guess at a row's height, in px — one visual line of note-sized text
 * plus its block spacing.
 *
 * Only a guess: lines wrap, so a row is as tall as the number of visual lines
 * the pane's width breaks it into, which nothing knows until the browser has
 * laid it out. Rows that have been drawn are measured; every row that has not
 * carries this number, which is what keeps the total size of a 33-million-line
 * file computable without touching 33 million lines.
 */
export const LARGE_FILE_LINE_HEIGHT = 32

/** Rows rendered either side of the viewport, so scrolling stays ahead of IPC. */
const OVERSCAN_ROWS = 24

export interface LargeFileViewerProps {
  noteId: string
  /** Which bound put the file out of note class, from the classifier. */
  reason: NoteLargeFileReason | null | undefined
  /** Measured size the reason refers to, when the main process reported one. */
  measuredBytes?: number | null
  /**
   * Whether this viewer is the surface the find shortcut belongs to. A viewer
   * in a background tab stays mounted, and two bars answering one keystroke is
   * worse than none.
   */
  active?: boolean
  /**
   * Filled with "open the find bar", so the Edit > Find menu item and the note
   * menu can reach a search that lives inside this component. Mirrors the
   * `focusAtEndRef` handshake the editor already uses.
   */
  openFindRef?: RefObject<(() => void) | null>
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
  active = true,
  openFindRef,
  className
}: LargeFileViewerProps) {
  const { t } = useT('notes')
  const { state, sessionId, getLine, isTruncated, ensureRange } = useLargeFileSession(noteId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const search = useLargeFileSearch(sessionId)

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

  const isReady = state.status === 'ready'
  const showRows = isReady && lineCount > 0

  // The virtualizer instance is stable, but the resize effect below must not
  // re-subscribe on every render to reach it.
  const virtualizerRef = useRef(virtualizer)
  useEffect(() => {
    virtualizerRef.current = virtualizer
  })

  // Bumped on a width change to remount the drawn rows. Clearing the height
  // cache is not enough on its own: a row already in the DOM whose own box the
  // browser has settled never fires its own observer again, so it would be
  // stranded on the estimate. Remounting makes it measure itself once more.
  const [widthEpoch, setWidthEpoch] = useState(0)

  // A row's height is only true at the width it was measured at — the wrap
  // point is the pane's width. Heights measured before a resize are dropped;
  // rows off screen fall back to the estimate until they are scrolled back to.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    let lastWidth = element.getBoundingClientRect().width
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.getBoundingClientRect().width
      if (width === lastWidth) return
      lastWidth = width
      virtualizerRef.current.measure()
      setWidthEpoch((epoch) => epoch + 1)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [showRows])

  const openFind = search.open
  const canFind = isReady && lineCount > 0

  // The app's find affordance, matched rather than reinvented: the same
  // Cmd/Ctrl+F, and the same bar. `useFindInPage` is switched off for this
  // surface in note.tsx — it walks the DOM, and the DOM here is a few dozen
  // rows out of millions.
  useEffect(() => {
    if (!active || !canFind) return
    const handler = (event: KeyboardEvent): void => {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const modifier = isMac ? event.metaKey : event.ctrlKey
      if (!modifier || event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      event.stopPropagation()
      openFind()
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [active, canFind, openFind])

  // Edit > Find and the note menu reach the bar through this.
  useEffect(() => {
    if (!openFindRef) return
    openFindRef.current = canFind ? openFind : null
    return () => {
      openFindRef.current = null
    }
  }, [openFindRef, canFind, openFind])

  const currentHit = search.currentHit
  useEffect(() => {
    if (!currentHit) return
    virtualizer.scrollToIndex(currentHit.line, { align: 'center' })
    // The virtualizer identity changes every render; the hit is what moves the
    // viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHit])

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
      className={cn('relative flex h-full min-h-[60vh] flex-col', className)}
    >
      {canFind && (
        <FindBar
          isOpen={search.isOpen}
          query={search.query}
          matchCount={search.total}
          currentIndex={search.currentIndex}
          inputRef={search.inputRef}
          onQueryChange={search.setQuery}
          onNext={search.next}
          onPrev={search.prev}
          onClose={search.close}
          countLabel={countLabel(t, search)}
          className="top-3"
        />
      )}

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

      {showRows && (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {rows.map((row) => (
              <LineRow
                key={`${widthEpoch}:${row.key}`}
                line={row.index}
                offset={row.start}
                text={getLine(row.index)}
                truncated={isTruncated(row.index)}
                truncatedLabel={t('page.largeFile.viewer.lineTruncated')}
                query={search.isOpen ? search.query : ''}
                activeOrdinal={currentHit?.line === row.index ? currentHit.ordinal : null}
                measureRef={virtualizer.measureElement}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
})

type Translate = ReturnType<typeof useT>['t']

/**
 * What the find bar says about the count.
 *
 * Two cases the note find bar never has, both of which would be a lie as a bare
 * `3/128`: a pass still crossing the file, where the count is still growing,
 * and a hit list capped for navigation, where it is only part of the total.
 * `undefined` falls back to the bar's own `current/total`.
 */
function countLabel(t: Translate, search: LargeFileSearch): string | undefined {
  if (search.searching) return t('page.largeFile.find.searching', { count: search.total })
  if (search.limited) {
    return t('page.largeFile.find.limited', {
      index: search.currentIndex + 1,
      shown: search.hits.length,
      total: search.total
    })
  }
  return undefined
}

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
    // No horizontal padding: the note layout already sets the column this sits
    // in, so the bar and the file's text share one edge, the way a note's own
    // rules and text do.
    <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-2">
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

/** ASCII-only lowercase — the same fold the main-process pass applies. */
function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/** Highlight of every match, drawn over line text the viewer already holds. */
const MATCH_CLASS = 'bg-amber-200 text-inherit dark:bg-amber-400/35'
const CURRENT_MATCH_CLASS = 'bg-amber-500 text-white dark:bg-amber-500/75'

/**
 * One line with its matches marked.
 *
 * The occurrences are re-found here rather than sent: the line text is already
 * on screen, and the fold and the non-overlapping advance are the same as the
 * pass's, so the Nth match here is the pass's ordinal N. Sending character
 * offsets instead would mean translating byte offsets, which is exactly where
 * a multi-byte character goes wrong.
 */
function HighlightedLine({
  text,
  query,
  activeOrdinal
}: {
  text: string
  query: string
  activeOrdinal: number | null
}): React.JSX.Element {
  if (!query || !text) return <>{text}</>

  const haystack = foldAscii(text)
  const needle = foldAscii(query)
  const parts: React.JSX.Element[] = []
  let from = 0
  let ordinal = 0

  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    if (at > from) parts.push(<span key={`t${from}`}>{text.slice(from, at)}</span>)
    parts.push(
      <mark
        key={`m${at}`}
        className={cn(
          'rounded-[2px]',
          ordinal === activeOrdinal ? CURRENT_MATCH_CLASS : MATCH_CLASS
        )}
      >
        {text.slice(at, at + needle.length)}
      </mark>
    )
    ordinal += 1
    from = at + needle.length
  }

  if (parts.length === 0) return <>{text}</>
  if (from < text.length) parts.push(<span key={`t${from}`}>{text.slice(from)}</span>)
  return <>{parts}</>
}

/**
 * One line of the file, set as a note sets a paragraph.
 *
 * No line number and no monospace: a note has neither, and this surface is a
 * note that happens to be too big to edit. The height is the DOM's to decide —
 * `measureRef` reports it back — because a 17 KB line of minified JSON is one
 * *file* line and something like 170 *visual* lines, and the number depends on
 * how wide the pane is.
 */
const LineRow = memo(function LineRow({
  line,
  offset,
  text,
  truncated,
  truncatedLabel,
  query,
  activeOrdinal,
  measureRef
}: {
  line: number
  offset: number
  text: string | undefined
  truncated: boolean
  truncatedLabel: string
  query: string
  activeOrdinal: number | null
  measureRef: (node: HTMLElement | null) => void
}) {
  return (
    <div
      data-index={line}
      ref={measureRef}
      className="absolute top-0 start-0 w-full"
      style={{ transform: `translateY(${offset}px)` }}
    >
      {/* `whitespace-pre-wrap` keeps the file's own spacing while letting the
          line wrap; `break-words` is what lets it break at all, because a
          minified record has no space in it to break at. `min-h-[1lh]` holds a
          blank line — and a line whose page has not arrived — open at one line,
          which a collapsed row would report as zero height. */}
      <p className="min-h-[1lh] py-[3px] text-base leading-relaxed whitespace-pre-wrap break-words text-foreground">
        <HighlightedLine text={text ?? ''} query={query} activeOrdinal={activeOrdinal} />
        {truncated && (
          <span className="ms-2 rounded-sm bg-muted px-1 align-middle text-[0.7em] text-muted-foreground">
            {truncatedLabel}
          </span>
        )}
      </p>
    </div>
  )
})

export default LargeFileViewer
