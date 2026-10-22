/**
 * A portal onto a note or one block of it: the rail and header around a live
 * window, or the state card when the source cannot be shown.
 *
 * @module note/content-area/portal/portal-note-view
 */

import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { PortalDefinition } from '@memry/shared/portal-block'
import { useNote } from '@/hooks/use-notes-query'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { useSyncOptional } from '@/contexts/sync-context'
import { Eye, ExternalLink, Link, Lock } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { useIsNoteLocked } from '@/lib/vault-locks-store'
import { useAttachmentNoteId } from '../note-file-url-context'
import { usePortalAncestry } from './portal-context'
import {
  PortalActionButton,
  PortalActions,
  PortalChip,
  PortalGlyph,
  PortalHeaderRow,
  PortalRail
} from './portal-chrome'
import { portalFenceText, type PortalEditorLike } from './portal-definition'
import {
  getPortalActionHandlers,
  usePortalHiddenBlocksSlot,
  type PortalHandle
} from './portal-slots'
import {
  isPortalBlocked,
  resolvePortalStatus,
  withHostFrame,
  type PortalWindowTarget
} from './portal-state'
import { PortalStateCard } from './portal-state-card'
import { PortalWindow } from './portal-window'
import type { PortalWindowResolution } from './use-portal-window-plugin'

const log = createLogger('PortalNoteView')

export interface PortalNoteViewProps {
  blockId: string
  editor: PortalEditorLike
  definition: PortalDefinition
  target: PortalWindowTarget
  raw: Record<string, unknown>
}

export function PortalNoteView({
  blockId,
  editor,
  definition,
  target,
  raw
}: PortalNoteViewProps): React.JSX.Element {
  const { t } = useT('common')
  const hostNoteId = useAttachmentNoteId()
  const ancestry = withHostFrame(usePortalAncestry(), hostNoteId)
  const { note, isLoading } = useNote(target.note)
  const locked = useIsNoteLocked(target.note, note?.path ?? null)
  const sync = useSyncOptional()
  const { openSidebarItem } = useSidebarNavigation()
  const HiddenBlocksSlot = usePortalHiddenBlocksSlot()
  const [resolution, setResolution] = useState<PortalWindowResolution>({
    rootFound: null,
    rootText: null
  })

  const syncing = sync
    ? sync.state.status === 'syncing' || sync.state.initialSyncProgress !== null
    : false
  const status = resolvePortalStatus({
    target,
    ancestry,
    source: isLoading ? 'loading' : note ? 'found' : 'missing',
    syncing,
    locked,
    blockFound: resolution.rootFound
  })

  const handle = useMemo<PortalHandle>(
    () => ({ blockId, editor, definition, sourceNoteId: target.note, hostNoteId }),
    [blockId, editor, definition, target.note, hostNoteId]
  )

  const openSource = useCallback(
    (event?: React.MouseEvent) => {
      if (!note) return
      openSidebarItem(
        { type: 'note', path: note.path, entityId: note.id, title: note.title, emoji: note.emoji },
        event && (event.metaKey || event.ctrlKey) ? { inNewTab: true } : undefined
      )
    },
    [note, openSidebarItem]
  )

  const copyPortal = useCallback(() => {
    navigator.clipboard
      .writeText(portalFenceText(definition, raw))
      .then(() => toast.success(t('portalBlock.copied')))
      .catch((err: unknown) => {
        log.error('Failed to copy the portal', err)
        toast.error(t('portalBlock.copyFailed'))
      })
  }, [definition, raw, t])

  const title = note?.title
  const breadcrumb =
    title && target.kind === 'block' && resolution.rootText
      ? t('portalBlock.breadcrumb', { note: title, block: resolution.rootText })
      : title

  if (isPortalBlocked(status)) {
    const card = status as Parameters<typeof PortalStateCard>[0]['status']
    const action = (): void => {
      if (card === 'missing-note') editor.removeBlocks([blockId])
      else if (card === 'missing-block') getPortalActionHandlers().pickAnotherBlock?.(handle)
      else if (card === 'not-synced') void sync?.triggerSync()
      else openSource()
    }
    const hasAction =
      card === 'missing-block'
        ? getPortalActionHandlers().pickAnotherBlock !== undefined
        : card === 'not-synced'
          ? sync !== null
          : card === 'missing-note'
            ? editor.isEditable
            : note !== null && note !== undefined
    return (
      <>
        <PortalStateCard
          status={card}
          sourceTitle={title}
          breadcrumb={breadcrumb}
          onAction={hasAction ? action : undefined}
        />
        {/* A block that is gone may come back (a sync lands). The window stays
            mounted, unseen, so it can say so. */}
        {card === 'missing-block' && note ? (
          <div hidden>
            <PortalWindow
              portalBlockId={blockId}
              target={target}
              hidden={definition.hidden}
              ancestry={ancestry}
              sourcePath={note.path}
              sourceContent={note.content}
              editable={false}
              onResolve={setResolution}
            />
          </div>
        ) : null}
      </>
    )
  }

  const hiddenCount = definition.hidden.length
  const hiddenChip =
    hiddenCount > 0 ? (
      <button
        type="button"
        className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label={t('portalBlock.hiddenBlocks')}
      >
        <PortalChip>{t('portalBlock.hiddenCount', { count: hiddenCount })}</PortalChip>
      </button>
    ) : null
  const editTrigger = (
    <PortalActionButton label={t('portalBlock.editVisibleBlocks')} disabled={!editor.isEditable}>
      <Eye className="size-3.5" aria-hidden="true" />
    </PortalActionButton>
  )

  return (
    <PortalRail tone="tint" data-portal-kind={target.kind}>
      <PortalHeaderRow>
        <PortalGlyph className="text-tint" />
        <button
          type="button"
          onClick={openSource}
          disabled={!note}
          className="min-w-0 truncate text-start text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:underline disabled:cursor-default disabled:hover:text-muted-foreground"
        >
          {breadcrumb ?? '\u00a0'}
        </button>
        <div className="grow" />
        {locked ? (
          <PortalChip>
            <Lock className="size-3" aria-hidden="true" />
            {t('portalBlock.states.locked.title')}
          </PortalChip>
        ) : null}
        {hiddenChip && HiddenBlocksSlot ? (
          <HiddenBlocksSlot portal={handle}>{hiddenChip}</HiddenBlocksSlot>
        ) : (
          hiddenChip
        )}
        <PortalActions>
          <PortalActionButton label={t('portalBlock.openSource')} onClick={openSource}>
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </PortalActionButton>
          {HiddenBlocksSlot ? (
            <HiddenBlocksSlot portal={handle}>{editTrigger}</HiddenBlocksSlot>
          ) : (
            editTrigger
          )}
          <PortalActionButton label={t('portalBlock.copyPortal')} onClick={copyPortal}>
            <Link className="size-3.5" aria-hidden="true" />
          </PortalActionButton>
        </PortalActions>
      </PortalHeaderRow>
      {note ? (
        <PortalWindow
          portalBlockId={blockId}
          target={target}
          hidden={definition.hidden}
          ancestry={ancestry}
          sourcePath={note.path}
          sourceContent={note.content}
          editable={!locked && editor.isEditable}
          onResolve={setResolution}
        />
      ) : null}
    </PortalRail>
  )
}
