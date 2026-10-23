import { useCallback, useEffect, useState } from 'react'
import type { StickyDraft } from '@memry/contracts/sticky-api'
import { useT } from '@memry/i18n/renderer'
import { Plus, StickyNote } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'

const log = createLogger('Component:StickyEdgeTab')

/** Rows the peek list shows; main sizes the window for the same number. */
const PEEK_MAX_ROWS = 5

function firstLine(content: string): string {
  return content.trim().split('\n', 1)[0] ?? ''
}

/**
 * The edge tab: while the sticky is tucked away, a tab on the screen edge
 * holds its drafts. Hover peeks at them; a click unfolds the sticky on one.
 */
export function StickyEdgeTab(): React.JSX.Element {
  const { t } = useT('inbox')
  const [drafts, setDrafts] = useState<StickyDraft[]>([])
  const [edge, setEdge] = useState<'left' | 'right'>('right')
  const [peeking, setPeeking] = useState(false)

  const load = useCallback(async () => {
    try {
      const [list, settings] = await Promise.all([
        window.api.sticky.listDrafts(),
        window.api.settings.getStickySettings()
      ])
      setDrafts(list)
      setEdge(settings.tuckEdge)
    } catch (err) {
      log.error('Failed to load sticky drafts', err)
    }
  }, [])

  useEffect(() => {
    void load()
    return window.api.sticky.onDraftsChanged(() => void load())
  }, [load])

  const peek = (open: boolean): void => {
    setPeeking(open)
    void window.api.sticky.peek(open)
  }

  const unfold = (draftId: string | null): void => {
    void window.api.sticky.unfold(draftId)
  }

  const tab = (
    <button
      type="button"
      onClick={() => {
        unfold(drafts[0]?.id ?? null)
      }}
      aria-label={t('sticky.tab.label', { count: drafts.length })}
      className={cn(
        'flex h-[72px] w-8 shrink-0 flex-col items-center justify-center gap-1.5',
        'border border-border bg-popover text-popover-foreground',
        'shadow-[0_4px_14px_rgba(0,0,0,0.18)]',
        edge === 'right' ? 'rounded-s-xl' : 'rounded-e-xl'
      )}
    >
      <StickyNote className="size-4" aria-hidden="true" />
      <span className="text-[11px]/3 font-semibold tabular-nums">{drafts.length}</span>
    </button>
  )

  return (
    <div
      onMouseEnter={() => {
        peek(true)
      }}
      onMouseLeave={() => {
        peek(false)
      }}
      className={cn(
        'flex h-screen w-screen items-start pt-1.5',
        edge === 'right' ? 'flex-row-reverse' : 'flex-row'
      )}
    >
      {tab}
      {peeking && (
        <div className="mx-1.5 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-popover py-1.5 text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
          <ul>
            {drafts.slice(0, PEEK_MAX_ROWS).map((draft) => (
              <li key={draft.id}>
                <button
                  type="button"
                  onClick={() => {
                    unfold(draft.id)
                  }}
                  className="flex h-[52px] w-full flex-col justify-center px-3 text-start hover:bg-foreground/[0.06]"
                >
                  <span className="truncate text-[13px]/5 font-medium">
                    {firstLine(draft.content)}
                  </span>
                  <span className="text-[11px]/4 text-muted-foreground">
                    {t(`sticky.kinds.${draft.kind}`)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              unfold(null)
            }}
            className="mt-auto flex items-center gap-1.5 px-3 py-2 text-[12px]/4 font-medium text-[var(--tint)] hover:bg-foreground/[0.06]"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t('sticky.tab.newSticky')}
          </button>
        </div>
      )}
    </div>
  )
}
