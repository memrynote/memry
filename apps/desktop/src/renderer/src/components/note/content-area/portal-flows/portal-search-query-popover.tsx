/**
 * The search portal's query editor (artboard 6): text, tag and limit. Used to
 * create a search portal from `/search portal`, and by the portal block to edit
 * an existing one. Submitting hands back the strict target; what to do with it
 * (insert a block, rewrite a definition) is the caller's.
 *
 * @module note/content-area/portal-flows/portal-search-query-popover
 */

import { useState, type SubmitEvent, type ReactElement, type RefObject } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useT } from '@memry/i18n/renderer'
import {
  EMPTY_SEARCH_DRAFT,
  draftFromTarget,
  targetFromDraft,
  type PortalSearchDraft,
  type PortalSearchTarget
} from './portal-search-query'

interface PortalSearchQueryPopoverProps {
  anchorEl: HTMLElement | null
  /** The query being edited; omitted when creating. */
  initial?: PortalSearchTarget
  onSubmit: (target: PortalSearchTarget) => void
  onClose: () => void
}

export function PortalSearchQueryPopover({
  anchorEl,
  initial,
  onSubmit,
  onClose
}: PortalSearchQueryPopoverProps): ReactElement {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Radix types virtualRef as a non-null ref; anchorEl is null only while `open` is false, when the anchor is never measured
  const anchorRef = { current: anchorEl } as RefObject<HTMLElement>
  return (
    <Popover open={anchorEl !== null} onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[360px] rounded-xl p-2 shadow-[var(--shadow-dropdown)]"
        data-testid="portal-search-query"
      >
        {/* Remounts per open, so each opening starts from `initial`. */}
        <PortalSearchQueryForm
          key={initial ? JSON.stringify(initial) : 'new'}
          initial={initial}
          onSubmit={onSubmit}
        />
      </PopoverContent>
    </Popover>
  )
}

export function PortalSearchQueryForm({
  initial,
  onSubmit
}: Pick<PortalSearchQueryPopoverProps, 'initial' | 'onSubmit'>): ReactElement {
  const { t } = useT('notes')
  const [draft, setDraft] = useState<PortalSearchDraft>(
    initial ? draftFromTarget(initial) : EMPTY_SEARCH_DRAFT
  )
  const target = targetFromDraft(draft)
  const set = (patch: Partial<PortalSearchDraft>): void => setDraft({ ...draft, ...patch })

  const submit = (event: SubmitEvent): void => {
    event.preventDefault()
    if (target) onSubmit(target)
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <div className="px-2.5 py-2 text-sm font-semibold leading-[18px] text-foreground">
        {initial ? t('portalFlows.searchQuery.titleEdit') : t('portalFlows.searchQuery.titleNew')}
      </div>
      <label className="flex flex-col gap-1 px-2.5">
        <span className="text-xs leading-4 text-text-secondary">
          {t('portalFlows.searchQuery.text')}
        </span>
        <Input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- input opens inside a popover/dialog the user just invoked, so focus must land here
          autoFocus
          value={draft.text}
          placeholder={t('portalFlows.searchQuery.textPlaceholder')}
          onChange={(event) => set({ text: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 px-2.5">
        <span className="text-xs leading-4 text-text-secondary">
          {t('portalFlows.searchQuery.tag')}
        </span>
        <Input
          value={draft.tag}
          placeholder={t('portalFlows.searchQuery.tagPlaceholder')}
          onChange={(event) => set({ tag: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 px-2.5">
        <span className="text-xs leading-4 text-text-secondary">
          {t('portalFlows.searchQuery.limit')}
        </span>
        <Input
          inputMode="numeric"
          value={draft.limit}
          onChange={(event) => set({ limit: event.target.value })}
        />
      </label>
      <div className="flex items-center gap-2 px-2.5 pb-1 pt-2">
        <span className="flex-1 text-xs leading-4 text-text-secondary">
          {t('portalFlows.searchQuery.footer', { limit: target?.limit ?? '' })}
        </span>
        <Button type="submit" size="sm" disabled={!target}>
          {initial ? t('portalFlows.searchQuery.apply') : t('portalFlows.searchQuery.create')}
        </Button>
      </div>
    </form>
  )
}
