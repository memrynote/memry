/**
 * A portal whose content is a query (artboard 6): the blocks a search finds,
 * recomputed as notes change. Nothing is copied into the host note.
 *
 * Rows are read-only. Each opens its source note; checking a task or editing
 * text in place would need an editor per result, which is not cheap for up to
 * 200 rows, so editing stays where the block lives.
 *
 * @module note/content-area/portal/portal-search-view
 */

import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'
import { stripAnchor, type PortalDefinition, type PortalTarget } from '@memry/shared/portal-block'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { FileText, Search } from '@/lib/icons'
import {
  onNoteCreated,
  onNoteDeleted,
  onNoteMoved,
  onNoteRenamed,
  onNoteUpdated
} from '@/services/notes-service'
import {
  PortalActionButton,
  PortalActions,
  PortalChip,
  PortalHeaderRow,
  PortalRail
} from './portal-chrome'
import { searchPortalBlocks, type PortalSearchResultItem } from './portal-api'
import type { PortalEditorLike } from './portal-definition'
import { usePortalSearchQuerySlot, type PortalHandle } from './portal-slots'

type SearchTarget = Extract<PortalTarget, { kind: 'search' }>

/** Wait this long after the last note event before running the query again. */
const REFRESH_DEBOUNCE_MS = 500

const SEARCH_KEY = 'portal-search'

/** Re-run every open search portal when any note changes. */
function useSearchPortalRefresh(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void queryClient.invalidateQueries({ queryKey: [SEARCH_KEY] })
      }, REFRESH_DEBOUNCE_MS)
    }
    const unsubscribers = [
      onNoteCreated(refresh),
      onNoteUpdated(refresh),
      onNoteDeleted(refresh),
      onNoteRenamed(refresh),
      onNoteMoved(refresh)
    ]
    return () => {
      if (timer) clearTimeout(timer)
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [queryClient])
}

/** The query as the reader would type it: `#tag words`. */
export function searchQueryLabel(target: SearchTarget): string {
  return [target.tag ? `#${target.tag}` : '', target.text ?? ''].filter(Boolean).join(' ')
}

function ResultRow({ item }: { item: PortalSearchResultItem }): React.JSX.Element {
  const { openSidebarItem } = useSidebarNavigation()
  return (
    <button
      type="button"
      data-portal-result=""
      onClick={(event) =>
        openSidebarItem(
          { type: 'note', path: item.path, entityId: item.noteId, title: item.title },
          event.metaKey || event.ctrlKey ? { inNewTab: true } : undefined
        )
      }
      className="flex w-full flex-col gap-0.5 py-1.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <span className="flex items-center gap-1.5 text-xs font-medium leading-4 text-foreground">
        <FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{item.title}</span>
      </span>
      <span className="text-[15px] leading-6 text-foreground">{stripAnchor(item.text)}</span>
    </button>
  )
}

export interface PortalSearchViewProps {
  blockId: string
  editor: PortalEditorLike
  definition: PortalDefinition
  target: SearchTarget
}

export function PortalSearchView({
  blockId,
  editor,
  definition,
  target
}: PortalSearchViewProps): React.JSX.Element {
  const { t } = useT('common')
  const QuerySlot = usePortalSearchQuerySlot()
  useSearchPortalRefresh()

  const { text, tag, limit } = target
  const query = useQuery({
    queryKey: [SEARCH_KEY, text ?? null, tag ?? null, limit],
    queryFn: () => searchPortalBlocks({ text, tag, limit }),
    staleTime: REFRESH_DEBOUNCE_MS
  })

  const handle: PortalHandle = {
    blockId,
    editor,
    definition,
    sourceNoteId: null,
    hostNoteId: undefined
  }
  const results = query.data?.results ?? []
  const editQuery = (
    <PortalActionButton label={t('portalBlock.search.editQuery')} disabled={!editor.isEditable}>
      <Search className="size-3.5" aria-hidden="true" />
    </PortalActionButton>
  )

  let body: React.ReactNode
  if (query.isError) {
    body = (
      <div className="flex items-center gap-2 pt-1 text-xs text-destructive" role="alert">
        <span>{t('portalBlock.search.failed')}</span>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="rounded-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {t('portalBlock.search.retry')}
        </button>
      </div>
    )
  } else if (query.isLoading) {
    body = <p className="pt-1 text-xs text-muted-foreground">{t('portalBlock.search.loading')}</p>
  } else if (results.length === 0) {
    body = <p className="pt-1 text-xs text-muted-foreground">{t('portalBlock.search.empty')}</p>
  } else {
    body = (
      <div className="flex flex-col border-t border-border pt-1">
        {results.map((item) => (
          <ResultRow key={`${item.noteId}:${item.blockId}`} item={item} />
        ))}
        {query.data?.truncated ? (
          <p className="pt-1 text-xs text-muted-foreground">
            {t('portalBlock.search.truncated', { count: limit })}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <PortalRail tone="tint-dashed" data-portal-kind="search">
      <PortalHeaderRow>
        <Search className="size-3.5 shrink-0 text-tint" aria-hidden="true" />
        <span className="min-w-0 truncate font-mono text-xs leading-[18px] text-foreground">
          {searchQueryLabel(target)}
        </span>
        <div className="grow" />
        {query.data ? (
          <PortalChip>{t('portalBlock.search.count', { count: results.length })}</PortalChip>
        ) : null}
        <PortalActions>
          {QuerySlot ? <QuerySlot portal={handle}>{editQuery}</QuerySlot> : editQuery}
        </PortalActions>
      </PortalHeaderRow>
      {body}
    </PortalRail>
  )
}
