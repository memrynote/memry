/**
 * Everything the portal insert and manage flows need inside an editor, in one
 * component to mount in `<BlockNoteView>`: the `((` picker, the search portal
 * query popover, the where-used popover and usage chips, the delete guard, and
 * the Option+drag drop. It registers a small API (`portal-flows-api`) for the
 * block side menu and `/` menu to call.
 *
 * @module note/content-area/portal-flows/portal-flows-layer
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { SideMenuExtension } from '@blocknote/core/extensions'
import { SuggestionMenuController, useBlockNoteEditor, useExtensionState } from '@blocknote/react'
import { toast } from 'sonner'
import { extractAnchor } from '@memry/shared/portal-block'
import { useT } from '@memry/i18n/renderer'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import type { EditorSchema } from '../editor-schema'
import { getPortalUsage, stampPortalAnchor, type PortalHost } from './portal-api'
import { guardBlockText } from './portal-delete-guard'
import { blockDefinition, insertPortalBlock, portalFenceMarkdown } from './portal-insert'
import { PortalPicker, PortalPickerContext } from './portal-picker'
import { PORTAL_PICKER_TRIGGER } from './portal-slash-items'
import { registerPortalFlowsApi } from './portal-flows-api'
import { PortalSearchQueryPopover } from './portal-search-query-popover'
import { searchDefinition, type PortalSearchTarget } from './portal-search-query'
import { PortalWhereUsedPopover } from './portal-where-used-popover'
import { useRegisterPortalSlots } from './portal-slot-components'
import { usePortalBlockDrop } from './use-portal-block-drop'
import { usePortalDeleteGuard } from './use-portal-delete-guard'
import { usePortalPicker } from './use-portal-picker'
import { usePortalUsageChips } from './use-portal-usage-chips'

const log = createLogger('PortalFlows')

type Editor = EditorSchema['BlockNoteEditor']

export interface PortalFlowsLayerProps {
  /** Absent while a note is still being created; nothing here can run without it. */
  noteId: string | undefined
  /** Vault-relative path, for the note's name in the delete confirm. */
  notePath?: string
  editable: boolean
  /** Notes whose portals this editor is nested in, outermost first. */
  ancestry: readonly string[]
  /** Opens a note by id (the host in the where-used popover). */
  onOpenNote?: (noteId: string) => void
  /** Inside a portal window: hide blocks from the portal instead of deleting them. */
  removeFromPortal?: (blockIds: readonly string[]) => void
}

/** `Lectures/Cell Biology.md` -> `Cell Biology`. */
export function titleFromPath(path: string | undefined): string {
  const name = (path ?? '').split('/').pop() ?? ''
  return name.replace(/\.md$/i, '')
}

export function PortalFlowsLayer({
  noteId,
  notePath,
  editable,
  ancestry,
  onOpenNote,
  removeFromPortal
}: PortalFlowsLayerProps): ReactElement | null {
  const { t } = useT('notes')
  const editor = useBlockNoteEditor() as unknown as Editor
  const hoveredBlockId = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block?.id
  })

  const picker = usePortalPicker(editor, noteId, ancestry)
  const pickerContext = useMemo(
    () => ({
      pickWithChildren: (item: Parameters<typeof picker.pick>[0]) => void picker.pick(item, true)
    }),
    [picker]
  )

  const { requestBlockRemoval, dialog } = usePortalDeleteGuard({
    editor,
    noteId,
    noteTitle: titleFromPath(notePath),
    removeFromPortal
  })

  // Where-used popover, hung from a usage chip.
  const [whereUsed, setWhereUsed] = useState<{ chip: HTMLElement; hosts: PortalHost[] } | null>(
    null
  )
  const openWhereUsed = useCallback(
    (anchor: string, chip: HTMLElement) => {
      if (!noteId) return
      getPortalUsage(noteId, anchor)
        .then((hosts) => setWhereUsed({ chip, hosts }))
        .catch((err: unknown) => {
          log.error('Failed to load where a block is used', err)
          toast.error(extractErrorMessage(err, t('portalFlows.whereUsed.loadFailed')))
        })
    },
    [noteId, t]
  )
  usePortalUsageChips(editor, noteId, openWhereUsed)

  // Search portal creation: the query popover, hung from the caret's block.
  const [searchAnchor, setSearchAnchor] = useState<HTMLElement | null>(null)
  const submitSearch = (target: PortalSearchTarget): void => {
    setSearchAnchor(null)
    insertPortalBlock(editor, searchDefinition(target))
  }

  usePortalBlockDrop({ editor, noteId, editable, ancestry, hoveredBlockId })
  useRegisterPortalSlots()

  const copyPortalToBlock = useCallback(
    async (blockId: string): Promise<void> => {
      if (!noteId) return
      try {
        const block = editor.getBlock(blockId)
        // A block that already ends with an anchor keeps it; stamping is
        // idempotent, but skipping the round trip keeps a copy instant.
        let anchor = block ? extractAnchor(guardBlockText(block)) : null
        if (!anchor) {
          const stamped = await stampPortalAnchor(noteId, blockId)
          if (!stamped.success) throw new Error(stamped.reason)
          anchor = stamped.anchor
        }
        await navigator.clipboard.writeText(portalFenceMarkdown(blockDefinition(noteId, anchor)))
        toast.success(t('portalFlows.copy.done'))
      } catch (err) {
        log.error('Failed to copy a portal', err)
        toast.error(extractErrorMessage(err, t('portalFlows.copy.failed')))
      }
    },
    [editor, noteId, t]
  )

  const startReplaceRef = useRef(picker.startReplace)
  startReplaceRef.current = picker.startReplace
  const requestRef = useRef(requestBlockRemoval)
  requestRef.current = requestBlockRemoval
  const copyRef = useRef(copyPortalToBlock)
  copyRef.current = copyPortalToBlock
  useEffect(() => {
    if (!noteId) return
    return registerPortalFlowsApi(editor, {
      noteId,
      requestBlockRemoval: (ids) => requestRef.current(ids),
      copyPortalToBlock: (id) => copyRef.current(id),
      pickAnotherBlock: (id) => startReplaceRef.current(id),
      openSearchCreate: () => {
        const blockId = editor.getTextCursorPosition().block.id
        const el = editor.domElement?.querySelector<HTMLElement>(
          `[data-id="${CSS.escape(blockId)}"]`
        )
        setSearchAnchor(el ?? editor.domElement ?? null)
      }
    })
  }, [editor, noteId])

  return (
    <>
      {editable ? (
        <PortalPickerContext value={pickerContext}>
          <SuggestionMenuController
            triggerCharacter={PORTAL_PICKER_TRIGGER}
            getItems={picker.getItems}
            suggestionMenuComponent={PortalPicker}
            onItemClick={(item) => void picker.pick(item)}
          />
        </PortalPickerContext>
      ) : null}
      <PortalSearchQueryPopover
        anchorEl={searchAnchor}
        onSubmit={submitSearch}
        onClose={() => setSearchAnchor(null)}
      />
      <PortalWhereUsedPopover
        anchorEl={whereUsed?.chip ?? null}
        hosts={whereUsed?.hosts ?? []}
        onOpenHost={(host) => {
          setWhereUsed(null)
          onOpenNote?.(host.noteId)
        }}
        onClose={() => setWhereUsed(null)}
      />
      {dialog}
    </>
  )
}
