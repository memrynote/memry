/**
 * WikiLink suggestion menu for BlockNote.
 */

import type { SuggestionMenuProps } from '@blocknote/react'
import { FileAudio, FileText, Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

type WikiLinkFileType = 'markdown' | 'pdf' | 'image' | 'audio' | 'video'
type WikiLinkInsertMode = 'wikiLink' | 'embed'

export type WikiLinkSuggestionItem = {
  id: string
  title: string
  target: string
  alias?: string
  exists: boolean
  type: 'note' | 'create'
  lastEdited?: string
  fileType?: WikiLinkFileType
  mimeType?: string | null
  fileSize?: number | null
  insertMode?: WikiLinkInsertMode
}

export function WikiLinkMenu({
  items,
  loadingState,
  selectedIndex,
  onItemClick
}: SuggestionMenuProps<WikiLinkSuggestionItem>) {
  const { t } = useT('notes')
  const embedLabel = t('menus.wiki.embed')
  const wikiLinkLabel = t('menus.wiki.wikiLink')

  if (items.length === 0 && loadingState !== 'loaded') {
    return (
      <div className="wiki-link-menu min-w-[220px] rounded-md border bg-popover p-2 text-sm text-muted-foreground shadow-md">
        {t('menus.wiki.loading')}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="wiki-link-menu min-w-[220px] rounded-md border bg-popover p-3 text-sm text-muted-foreground shadow-md">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 opacity-70" />
          <span>{t('menus.wiki.empty')}</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'wiki-link-menu z-50 min-w-[220px] max-w-[360px] max-h-[300px]',
        'overflow-y-auto rounded-md border bg-popover p-1',
        'shadow-md animate-in fade-in-0 zoom-in-95'
      )}
      role="listbox"
      aria-label={t('menus.wiki.aria')}
    >
      {items.map((item, index) => {
        const isSelected = selectedIndex === index
        const isAudio = item.type === 'note' && item.fileType === 'audio'
        const itemClassName = cn(
          'wiki-link-menu-item',
          'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
          'hover:bg-accent hover:text-accent-foreground',
          isSelected && 'bg-accent text-accent-foreground'
        )

        if (isAudio) {
          return (
            <div
              key={`${item.type}-${item.id}-${item.target}`}
              className={itemClassName}
              role="option"
              aria-selected={isSelected}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-start outline-none"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onItemClick?.({ ...item, insertMode: 'wikiLink' })}
              >
                <FileAudio className="h-4 w-4 shrink-0 opacity-70" />
                <span className="truncate font-medium">{item.title}</span>
              </button>
              <div className="ms-2 flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-background hover:text-foreground"
                  aria-label={t('menus.wiki.embedAria', { title: item.title })}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onItemClick?.({ ...item, insertMode: 'embed' })
                  }}
                >
                  {embedLabel}
                </button>
                <button
                  type="button"
                  className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-background hover:text-foreground"
                  aria-label={t('menus.wiki.wikiLinkAria', { title: item.title })}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onItemClick?.({ ...item, insertMode: 'wikiLink' })
                  }}
                >
                  {wikiLinkLabel}
                </button>
              </div>
            </div>
          )
        }

        return (
          <button
            key={`${item.type}-${item.id}-${item.target}`}
            className={itemClassName}
            onClick={() => onItemClick?.({ ...item, insertMode: 'wikiLink' })}
            role="option"
            aria-selected={isSelected}
          >
            {item.type === 'create' ? <Plus className="mt-0.5 h-4 w-4 shrink-0" /> : null}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-start">
              {item.type === 'create' ? (
                <>
                  <div className="font-medium">{t('menus.wiki.create')}</div>
                  <div className="text-xs text-muted-foreground">{item.target}</div>
                </>
              ) : (
                <div className="truncate font-medium">{item.title}</div>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
