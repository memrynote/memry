/**
 * A portal onto a note or some blocks of it: a live window behind a rail, with
 * a toolbar that floats in while the caret is inside, or one line saying why
 * the source cannot be shown.
 *
 * @module note/content-area/portal/portal-note-view
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { PortalDefinition } from '@memry/shared/portal-block'
import { useNote } from '@/hooks/use-notes-query'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { useSyncOptional } from '@/contexts/sync-context'
import { createLogger } from '@/lib/logger'
import { useIsNoteLocked } from '@/lib/vault-locks-store'
import { PortalRemoveFromContext } from '../portal-flows/portal-remove-context'
import { useAttachmentNoteId } from '../note-file-url-context'
import { commitPortalPlan, createPortalActions } from './portal-actions'
import { PortalFrame } from './portal-chrome'
import { usePortalAncestry } from './portal-context'
import { portalContentsMarkdown, portalLinkText } from './portal-copy'
import type { PortalEditorLike } from './portal-definition'
import type { PortalInlineHandlers } from './portal-inline-plugin'
import type { PortalPlan } from './portal-plans'
import {
  getPortalActionHandlers,
  usePortalHiddenBlocksSlot,
  type PortalHandle,
  type PortalHiddenScope
} from './portal-slots'
import {
  isPortalBlocked,
  resolvePortalStatus,
  withHostFrame,
  type PortalWindowTarget
} from './portal-state'
import { PortalStateCard } from './portal-state-card'
import { PortalToolbar } from './portal-toolbar'
import { PortalWindow } from './portal-window'
import type { PortalWindowResolution } from './use-portal-window-plugin'
import { usePortalInlineMarks, usePortalWindowState } from './use-portal-window-view'

const log = createLogger('PortalNoteView')

export interface PortalNoteViewProps {
  blockId: string
  editor: PortalEditorLike
  definition: PortalDefinition
  target: PortalWindowTarget
  /** The portal itself is the selection in its note (not a caret inside it). */
  selected: boolean
}

interface HiddenRequest {
  scope: PortalHiddenScope
  anchorEl: HTMLElement
}

/** Whether `blockId` is the one root a blocks portal has left: it cannot be hidden. */
function isOnlyRoot(
  target: PortalWindowTarget,
  state: ReturnType<typeof usePortalWindowState>,
  blockId: string
): boolean {
  if (target.kind !== 'blocks' || target.blocks.length !== 1) return false
  return state?.visible.find((b) => b.blockId === blockId)?.anchor === target.blocks[0]
}

export function PortalNoteView({
  blockId,
  editor,
  definition,
  target,
  selected
}: PortalNoteViewProps): React.JSX.Element {
  const { t } = useT('common')
  const hostNoteId = useAttachmentNoteId()
  const ancestry = withHostFrame(usePortalAncestry(), hostNoteId)
  const { note, isLoading } = useNote(target.note)
  const locked = useIsNoteLocked(target.note, note?.path ?? null)
  const sync = useSyncOptional()
  const { openSidebarItem } = useSidebarNavigation()
  const HiddenBlocksSlot = usePortalHiddenBlocksSlot()
  const windowState = usePortalWindowState(blockId)
  const windowStateRef = useRef(windowState)
  useEffect(() => {
    windowStateRef.current = windowState
  })
  const [resolution, setResolution] = useState<PortalWindowResolution>({
    rootFound: null,
    rootText: null
  })

  const [focusWithin, setFocusWithin] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [hiddenRequest, setHiddenRequest] = useState<HiddenRequest | null>(null)

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
  const handleRef = useRef(handle)
  useEffect(() => {
    handleRef.current = handle
  })
  const actions = useMemo(() => createPortalActions(() => handleRef.current), [])

  const reportFailure = useCallback(
    (done: boolean) => {
      if (!done) toast.error(t('portalBlock.actionFailed'))
    },
    [t]
  )
  // Enter or Backspace in the window changed what the portal lists.
  const applyPlan = useCallback(
    (plan: PortalPlan) => commitPortalPlan(handleRef.current, plan).then(reportFailure),
    [reportFailure]
  )

  const inlineHandlers = useRef<PortalInlineHandlers | null>(null)
  useEffect(() => {
    inlineHandlers.current = {
      hiddenLabel: (count) => t('portalBlock.hiddenCount', { count }),
      foldLabel: (expanded) =>
        expanded ? t('portalBlock.collapseChildren') : t('portalBlock.expandChildren'),
      editable: editor.isEditable && !locked,
      openHidden: (id, anchorEl) =>
        setHiddenRequest({ scope: { kind: 'children', blockId: id }, anchorEl }),
      toggleFold: (id, expanded) =>
        void (expanded ? actions.collapse(id) : actions.expandAll(id)).then(reportFailure)
    }
  })
  usePortalInlineMarks(blockId, inlineHandlers)

  const openSource = useCallback(
    (options?: { inNewTab?: boolean; toTheSide?: boolean }) => {
      if (!note) return
      openSidebarItem(
        {
          type: 'note',
          path: `/notes/${note.id}`,
          entityId: note.id,
          title: note.title,
          emoji: note.emoji
        },
        options
      )
    },
    [note, openSidebarItem]
  )

  const writeClipboard = useCallback(
    (text: string, done: string) => {
      navigator.clipboard
        .writeText(text)
        .then(() => toast.success(done))
        .catch((err: unknown) => {
          log.error('Failed to copy from the portal', err)
          toast.error(t('portalBlock.copyFailed'))
        })
    },
    [t]
  )

  // Hiding a block from inside the window (the block menu, the delete guard's
  // "Hide here instead") takes it out of this portal only.
  const removeFromPortal = useCallback(
    (ids: readonly string[]) => {
      void (async () => {
        for (const id of ids) {
          if (isOnlyRoot(target, windowStateRef.current, id)) {
            toast.message(t('portalBlock.keepsOneBlock'))
            continue
          }
          reportFailure(await actions.hide(id))
        }
      })()
    },
    [actions, reportFailure, target, t]
  )

  // A press with Shift on the portal's content opens the source beside this
  // note instead of editing in place.
  const openBesideOnShiftPress = (event: React.MouseEvent): void => {
    if (!event.shiftKey || event.button !== 0 || !note) return
    if (!(event.target instanceof Element) || !event.target.closest('[data-portal-window]')) return
    event.preventDefault()
    event.stopPropagation()
    openSource({ toTheSide: true })
  }

  const title = note?.title ?? ''

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
          sourceTitle={note?.title}
          onAction={hasAction ? action : undefined}
        />
        {/* A block that is gone may come back (a sync lands). The window stays
            mounted, unseen, so it can say so. */}
        {card === 'missing-block' && note ? (
          <div hidden>
            <PortalWindow
              portalBlockId={blockId}
              target={target}
              ancestry={ancestry}
              sourcePath={note.path}
              sourceContent={note.content}
              editable={false}
              onResolve={setResolution}
              onPlan={applyPlan}
            />
          </div>
        ) : null}
      </>
    )
  }

  const active = focusWithin || menuOpen || hiddenRequest !== null
  const hiddenSiblingCount =
    target.kind === 'blocks' ? (windowState?.hiddenSiblings.length ?? 0) : 0
  const toolbar =
    active || locked ? (
      <PortalToolbar
        title={title}
        ancestors={target.kind === 'blocks' ? (windowState?.ancestors ?? []) : []}
        hiddenSiblingCount={hiddenSiblingCount}
        locked={locked}
        compact={!active}
        editable={editor.isEditable && !locked}
        onIncludeParent={(ancestor) =>
          void actions.includeParent(ancestor.blockId).then(reportFailure)
        }
        onOpenHidden={(anchorEl) => setHiddenRequest({ scope: { kind: 'siblings' }, anchorEl })}
        onOpenSource={() => openSource()}
        onOpenBeside={() => openSource({ toTheSide: true })}
        onCopyContents={() =>
          writeClipboard(
            portalContentsMarkdown(windowState?.visible ?? []),
            t('portalBlock.copiedContents')
          )
        }
        onCopyLink={() =>
          writeClipboard(portalLinkText(title, target), t('portalBlock.copiedLink'))
        }
        onRemove={() => editor.removeBlocks([blockId])}
        onMenuOpenChange={setMenuOpen}
      />
    ) : null

  return (
    <PortalFrame
      focused={active}
      selected={selected}
      toolbar={toolbar}
      data-portal-kind={target.kind}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false)
      }}
      onMouseDownCapture={openBesideOnShiftPress}
    >
      {note ? (
        <PortalRemoveFromContext value={removeFromPortal}>
          <PortalWindow
            portalBlockId={blockId}
            target={target}
            ancestry={ancestry}
            sourcePath={note.path}
            sourceContent={note.content}
            editable={!locked && editor.isEditable}
            onResolve={setResolution}
            onPlan={applyPlan}
          />
        </PortalRemoveFromContext>
      ) : null}
      {HiddenBlocksSlot ? (
        <HiddenBlocksSlot
          portal={handle}
          scope={hiddenRequest?.scope ?? null}
          anchorEl={hiddenRequest?.anchorEl ?? null}
          onClose={() => setHiddenRequest(null)}
        />
      ) : null}
    </PortalFrame>
  )
}
