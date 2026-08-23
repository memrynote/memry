/**
 * Reveal / open / copy-path menu for attachment blocks (issue #1709).
 *
 * One item set, three surfaces: a secondary-click ContextMenu wrapping the
 * file block, a hover "⋯" DropdownMenu button inside it, and a positioned menu
 * for the built-in image block (which has no custom render to put a button in).
 * The raw `block.props.url` — never the resolved `memry-file://` URL — goes to
 * main, which resolves it against the note and rejects paths escaping the
 * vault. The header shows the original filename and the on-disk stored name,
 * which is what the beta feedback asked for: a way to find the original again.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { AttachmentResolveResult } from '@memry/contracts/notes-api'
import { Copy, ExternalLink, FolderOpen, MoreHorizontal } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAttachmentNoteId } from './note-file-url-context'

interface AttachmentMenuState {
  info: AttachmentResolveResult | null
  resolveFailed: boolean
  actionsDisabled: boolean
  handleOpenChange: (open: boolean) => void
  reveal: () => void
  openExternal: () => void
  copyPath: () => void
}

function useAttachmentMenu(url: string): AttachmentMenuState {
  const noteId = useAttachmentNoteId()
  const { t } = useT('notes')
  const [info, setInfo] = useState<AttachmentResolveResult | null>(null)
  const [resolveFailed, setResolveFailed] = useState(false)

  // Resolved lazily on menu open, not on block mount — a note can hold dozens
  // of attachment blocks and the answer can change when sync lands the file.
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open || !noteId) return
      setResolveFailed(false)
      window.api.notes
        .resolveAttachment(noteId, url)
        .then(setInfo)
        .catch(() => {
          setInfo(null)
          setResolveFailed(true)
        })
    },
    [noteId, url]
  )

  const reveal = useCallback(() => {
    if (!noteId) return
    window.api.notes.revealAttachmentInFinder(noteId, url).catch((err: unknown) => {
      toast.error(extractErrorMessage(err, t('editor.attachmentMenu.revealFailed')))
    })
  }, [noteId, url, t])

  const openExternal = useCallback(() => {
    if (!noteId) return
    window.api.notes.openAttachmentExternal(noteId, url).catch((err: unknown) => {
      toast.error(extractErrorMessage(err, t('editor.attachmentMenu.openFailed')))
    })
  }, [noteId, url, t])

  const copyPath = useCallback(() => {
    if (!info) return
    navigator.clipboard
      .writeText(info.absolutePath)
      .then(() => toast.success(t('page.toast.pathCopied')))
      .catch((err: unknown) => {
        toast.error(extractErrorMessage(err, t('page.toast.copyPathFailed')))
      })
  }, [info, t])

  return {
    info,
    resolveFailed,
    actionsDisabled: !noteId || resolveFailed || (info !== null && !info.exists),
    handleOpenChange,
    reveal,
    openExternal,
    copyPath
  }
}

/**
 * The shared body, parameterized over the Radix menu family — ContextMenu and
 * DropdownMenu items are distinct components but take the same props here.
 */
interface MenuComponents {
  Item: React.ComponentType<{
    disabled?: boolean
    onClick?: () => void
    children?: React.ReactNode
  }>
  Label: React.ComponentType<{ className?: string; children?: React.ReactNode }>
  Separator: React.ComponentType
}

function AttachmentMenuBody({
  name,
  state,
  components
}: {
  name: string
  state: AttachmentMenuState
  components: MenuComponents
}) {
  const { t } = useT('notes')
  const { Item, Label, Separator } = components
  const { info, actionsDisabled, reveal, openExternal, copyPath } = state

  return (
    <>
      <Label className="max-w-64">
        <span className="block truncate font-medium">{name}</span>
        {info && (
          <span
            className="block truncate text-xs font-normal text-muted-foreground"
            title={info.storedFilename}
          >
            {t('editor.attachmentMenu.storedAs', { name: info.storedFilename })}
          </span>
        )}
        {info !== null && !info.exists && (
          <span className="block text-xs font-normal text-muted-foreground">
            {t('editor.attachmentMenu.notSynced')}
          </span>
        )}
      </Label>
      <Separator />
      <Item disabled={actionsDisabled} onClick={reveal}>
        <FolderOpen className="h-4 w-4" />
        {t('editor.toolbar.revealInFinder')}
      </Item>
      <Item disabled={actionsDisabled} onClick={openExternal}>
        <ExternalLink className="h-4 w-4" />
        {t('editor.toolbar.openInDefaultApp')}
      </Item>
      <Item disabled={actionsDisabled || !info} onClick={copyPath}>
        <Copy className="h-4 w-4" />
        {t('editor.toolbar.copyPath')}
      </Item>
    </>
  )
}

const DROPDOWN_COMPONENTS: MenuComponents = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator
}

const CONTEXT_COMPONENTS: MenuComponents = {
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator
}

/** Secondary-click context menu wrapping a file block's rendered content. */
export function AttachmentBlockContextMenu({
  url,
  name,
  children
}: {
  url: string
  name: string
  children: React.ReactNode
}) {
  const state = useAttachmentMenu(url)

  return (
    <ContextMenu onOpenChange={state.handleOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="attachment-context-menu">
        <AttachmentMenuBody name={name} state={state} components={CONTEXT_COMPONENTS} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Hover "⋯" button opening the same menu, for inside the block's card. */
export function AttachmentMenuButton({
  url,
  name,
  className
}: {
  url: string
  name: string
  className?: string
}) {
  const state = useAttachmentMenu(url)
  const { t } = useT('notes')

  return (
    <DropdownMenu onOpenChange={state.handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('editor.attachmentMenu.menuLabel')}
          data-testid="attachment-menu-button"
          // Keep the editor from treating the press as a selection change
          // before the menu opens (same guard as the PDF alignment buttons).
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50',
            className
          )}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} data-testid="attachment-dropdown-menu">
        <AttachmentMenuBody name={name} state={state} components={DROPDOWN_COMPONENTS} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ============================================================================
// Image blocks — positioned menu from the editor's contextmenu event
// ============================================================================

export interface ImageMenuTarget {
  x: number
  y: number
  url: string
  name: string
}

/**
 * The built-in image block has no custom render to mount a trigger in, so the
 * menu opens as a controlled dropdown anchored to a fixed point at the click.
 */
export function ImageAttachmentMenu({
  target,
  onClose
}: {
  target: ImageMenuTarget
  onClose: () => void
}) {
  const state = useAttachmentMenu(target.url)
  const { handleOpenChange } = state

  // Controlled-open: resolve immediately, since there is no opening gesture
  // for onOpenChange to observe.
  useEffect(() => {
    handleOpenChange(true)
  }, [handleOpenChange])

  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span style={{ position: 'fixed', top: target.y, left: target.x, width: 0, height: 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="attachment-image-menu">
        <AttachmentMenuBody name={target.name} state={state} components={DROPDOWN_COMPONENTS} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
