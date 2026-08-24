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

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { AttachmentResolveResult } from '@memry/contracts/notes-api'
import { Copy, ExternalLink, FolderOpen, MoreHorizontal, Pencil } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { useFileActionLabels } from '@/hooks/use-file-action-labels'
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
import { AttachmentRenameFlow, type AttachmentRenamedHandler } from './attachment-rename-dialog'

export type { AttachmentRenamedHandler }

interface AttachmentMenuState {
  info: AttachmentResolveResult | null
  resolveFailed: boolean
  actionsDisabled: boolean
  handleOpenChange: (open: boolean) => void
  reveal: () => void
  openExternal: () => void
  copyPath: () => void
  /** Absent when the surface cannot write the result back into the block. */
  startRename?: () => void
  renameOpen: boolean
}

/**
 * Who owns the rename dialog.
 *
 * `onRenamed` — the menu owns it. Only safe where the menu itself stays
 * mounted (the file block's card).
 * `onRequestRename` — the HOST owns it, and the menu only asks. The image
 * surfaces need this: the editor unmounts them as soon as the menu closes or
 * the pointer leaves the image, which took the dialog down with it before it
 * ever rendered — clicking Rename appeared to do nothing.
 */
interface RenameWiring {
  onRenamed?: AttachmentRenamedHandler
  onRequestRename?: () => void
}

function useAttachmentMenu(
  url: string,
  name: string,
  rename: RenameWiring = {}
): AttachmentMenuState & { renameDialog: React.ReactNode } {
  const { onRenamed, onRequestRename } = rename
  const noteId = useAttachmentNoteId()
  const { t } = useT('notes')
  const [info, setInfo] = useState<AttachmentResolveResult | null>(null)
  const [resolveFailed, setResolveFailed] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)

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

  const renameDialog =
    onRenamed && renameOpen ? (
      <AttachmentRenameFlow
        url={url}
        name={info?.storedFilename && !name ? info.storedFilename : name}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        onRenamed={onRenamed}
      />
    ) : null

  return {
    info,
    resolveFailed,
    actionsDisabled: !noteId || resolveFailed || (info !== null && !info.exists),
    handleOpenChange,
    reveal,
    openExternal,
    copyPath,
    startRename: onRequestRename ?? (onRenamed ? () => setRenameOpen(true) : undefined),
    renameOpen,
    renameDialog
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
  const fileActions = useFileActionLabels()
  const { info, actionsDisabled, reveal, openExternal, copyPath, startRename } = state

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
        {fileActions.revealInFolder}
      </Item>
      <Item disabled={actionsDisabled} onClick={openExternal}>
        <ExternalLink className="h-4 w-4" />
        {fileActions.openInDefaultApp}
      </Item>
      <Item disabled={actionsDisabled || !info} onClick={copyPath}>
        <Copy className="h-4 w-4" />
        {t('editor.toolbar.copyPath')}
      </Item>
      {startRename && (
        <Item disabled={actionsDisabled} onClick={startRename}>
          <Pencil className="h-4 w-4" />
          {t('editor.attachmentRename.menuItem')}
        </Item>
      )}
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
  onRenamed,
  children
}: {
  url: string
  name: string
  onRenamed?: AttachmentRenamedHandler
  children: React.ReactNode
}) {
  const state = useAttachmentMenu(url, name, { onRenamed })

  return (
    <>
      <ContextMenu onOpenChange={state.handleOpenChange}>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent
          data-testid="attachment-context-menu"
          // The menu unmounts as the dialog mounts, and Radix restores focus to
          // the trigger on unmount — which pulls it straight back out of the
          // rename field. Declining the restore while renaming is the same guard
          // the sidebar's inline rename needs.
          onCloseAutoFocus={(event) => {
            if (state.renameOpen) event.preventDefault()
          }}
        >
          <AttachmentMenuBody name={name} state={state} components={CONTEXT_COMPONENTS} />
        </ContextMenuContent>
      </ContextMenu>
      {state.renameDialog}
    </>
  )
}

/** Hover "⋯" button opening the same menu, for inside the block's card. */
export function AttachmentMenuButton({
  url,
  name,
  className,
  onOpenChange,
  onRenamed,
  onRequestRename
}: {
  url: string
  name: string
  className?: string
  /** Extra open-state observer, chained after the resolve-on-open handler. */
  onOpenChange?: (open: boolean) => void
  onRenamed?: AttachmentRenamedHandler
  /** Host-owned rename — see {@link RenameWiring}. */
  onRequestRename?: () => void
}) {
  const state = useAttachmentMenu(url, name, { onRenamed, onRequestRename })
  const { t } = useT('notes')

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          state.handleOpenChange(open)
          onOpenChange?.(open)
        }}
      >
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
        <DropdownMenuContent
          align="end"
          sideOffset={8}
          data-testid="attachment-dropdown-menu"
          onCloseAutoFocus={(event) => {
            if (state.renameOpen) event.preventDefault()
          }}
        >
          <AttachmentMenuBody name={name} state={state} components={DROPDOWN_COMPONENTS} />
        </DropdownMenuContent>
      </DropdownMenu>
      {state.renameDialog}
    </>
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
  /** The image block this menu acts on, so a rename can write back to it. */
  blockId: string
}

/**
 * The built-in image block has no custom render to mount a trigger in, so the
 * menu opens as a controlled dropdown anchored to a fixed point at the click.
 */
export function ImageAttachmentMenu({
  target,
  onClose,
  onRequestRename
}: {
  target: ImageMenuTarget
  onClose: () => void
  /**
   * Host-owned rename. This menu is unmounted by the editor the moment it
   * closes, so it can only ask for the dialog — never render it.
   */
  onRequestRename?: () => void
}) {
  const state = useAttachmentMenu(target.url, target.name, { onRequestRename })
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

// ============================================================================
// Image blocks — hover "⋯" button floated over the image
// ============================================================================

export interface HoverImageTarget {
  url: string
  name: string
  /** The image block this menu acts on, so a rename can write back to it. */
  blockId: string
  /** Viewport coordinates for the button, from the image's bounding rect. */
  x: number
  y: number
}

/**
 * A floating "⋯" button that appears while the pointer is over an image block.
 *
 * The built-in image block has no custom render to mount a button in, so the
 * host tracks pointer-over on the editor container and derives the hovered
 * image's block props; this renders the same attachment menu at the image's
 * top inline-end corner. `data-attachment-hover-menu` marks the button so the
 * host's hover tracking treats moving onto it as still "on the image".
 */
export function ImageHoverMenuButton({
  target,
  onOpenChange,
  onRequestRename
}: {
  target: HoverImageTarget
  onOpenChange?: (open: boolean) => void
  /** Host-owned rename — this button is unmounted as soon as the menu closes. */
  onRequestRename?: () => void
}) {
  return (
    <div
      data-attachment-hover-menu
      style={{ position: 'fixed', top: target.y, left: target.x, zIndex: 30 }}
    >
      <AttachmentMenuButton
        url={target.url}
        name={target.name}
        onOpenChange={onOpenChange}
        onRequestRename={onRequestRename}
        className="h-6 w-6 rounded-md border border-border bg-background/90 shadow-sm"
      />
    </div>
  )
}

/**
 * Hover tracking for the floating image menu button.
 *
 * Attaches pointer listeners to the editor container; `resolveImage` maps a
 * hovered element to the image block's raw props (or null). The target is kept
 * while the pointer is on the image or the button, and while the menu is open.
 */
export function useImageHoverMenu(
  containerRef: React.RefObject<HTMLElement | null>,
  resolveImage: (el: HTMLElement) => { url: string; name: string; blockId: string } | null
): {
  hoverTarget: HoverImageTarget | null
  handleMenuOpenChange: (open: boolean) => void
} {
  const [hoverTarget, setHoverTarget] = useState<HoverImageTarget | null>(null)
  const menuOpenRef = useRef(false)

  const handleMenuOpenChange = useCallback((open: boolean) => {
    menuOpenRef.current = open
    if (!open) setHoverTarget(null)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const BUTTON_SIZE = 24
    const INSET = 8

    const handleOver = (e: MouseEvent) => {
      if (menuOpenRef.current) return
      const element = e.target as HTMLElement
      if (element.closest?.('[data-attachment-hover-menu]')) return

      const img = element.closest?.('img')
      if (img instanceof HTMLElement) {
        const info = resolveImage(img)
        if (info) {
          const rect = img.getBoundingClientRect()
          setHoverTarget({
            ...info,
            x: rect.right - BUTTON_SIZE - INSET,
            y: rect.top + INSET
          })
          return
        }
      }
      setHoverTarget(null)
    }

    // A fixed-position button goes stale the moment the note scrolls under it.
    const handleScroll = () => {
      if (!menuOpenRef.current) setHoverTarget(null)
    }

    container.addEventListener('mouseover', handleOver)
    container.addEventListener('scroll', handleScroll, true)
    return () => {
      container.removeEventListener('mouseover', handleOver)
      container.removeEventListener('scroll', handleScroll, true)
    }
  }, [containerRef, resolveImage])

  return { hoverTarget, handleMenuOpenChange }
}
