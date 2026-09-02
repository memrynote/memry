/**
 * Memry's block side menu — the menu behind a block's drag handle.
 *
 * BlockNote's stock drag-handle menu carries two items (Delete, Colors). This
 * one adds the rest of the Notion-shaped set: Turn into, Duplicate, Move to and
 * Comment. It is built ON TOP of the default items rather than replacing them,
 * so `RemoveBlockItem` / `BlockColorsItem` keep their behaviour, their markdown
 * round-trip and their `data-test` hooks.
 *
 * Everything acts on the block whose handle was clicked — never on a wider
 * multi-block selection, because the handle itself names the target.
 *
 * @module note/content-area/block-side-menu
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- BlockNote's own default
   drag-handle items type the editor as `<any, any, any>`; narrowing here would
   make Memry's heterogeneous block schema unassignable at every call site. */

import { useCallback, useMemo, type FC, type ReactNode } from 'react'
import {
  BlockColorsItem,
  RemoveBlockItem,
  SideMenu,
  SideMenuController,
  useBlockNoteEditor,
  useComponentsContext,
  useExtensionState
} from '@blocknote/react'
import { SideMenuExtension } from '@blocknote/core/extensions'
import { TextSelection } from 'prosemirror-state'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { BlockNoteEditor } from '@blocknote/core'
import { ArrowRight, Copy, MessageCircle, Palette, Trash2, Type } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import { isMac } from '@/lib/shortcut-registry'
import { getEditorSelectionFromState, getProseMirrorState } from './review-formatting-toolbar'
import type { ReviewSelection } from './types'

type AnyBlock = { id: string; type: string; props?: Record<string, unknown>; content?: unknown }

/**
 * Blocks with no inline text of their own. Turn into and Comment are hidden on
 * these: converting a file block to a heading is meaningless, and CriticMarkup
 * wraps TEXT — there is nothing for a comment to anchor to.
 */
const NON_TEXT_BLOCK_TYPES = new Set([
  'file',
  'image',
  'video',
  'audio',
  'youtubeEmbed',
  'bookmark',
  'taskBlock',
  'table'
])

/**
 * Blocks that own an attachment. "Move to" is hidden on these: the bytes live
 * under `attachments/<owning note id>/` and the target note's
 * `attachmentReferences` row never gains the id, so the embed would resolve on
 * this machine and be broken on every other device. Not a door to open by
 * accident — see the plan's Move to section.
 */
const ATTACHMENT_BLOCK_TYPES = new Set(['file', 'image', 'video', 'audio'])

/** Turn-into targets, in menu order. Heading carries its level as a prop. */
const TURN_INTO_TARGETS: Array<{ key: string; type: string; props?: Record<string, unknown> }> = [
  { key: 'paragraph', type: 'paragraph' },
  { key: 'heading1', type: 'heading', props: { level: 1 } },
  { key: 'heading2', type: 'heading', props: { level: 2 } },
  { key: 'heading3', type: 'heading', props: { level: 3 } },
  { key: 'bulletList', type: 'bulletListItem' },
  { key: 'numberedList', type: 'numberedListItem' },
  { key: 'checkList', type: 'checkListItem' },
  { key: 'toggleList', type: 'toggleListItem' },
  { key: 'quote', type: 'quote' },
  { key: 'codeBlock', type: 'codeBlock' },
  { key: 'callout', type: 'callout' }
]

function useCurrentBlock(): AnyBlock | undefined {
  const editor = useBlockNoteEditor<any, any, any>()
  return useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block
  }) as AnyBlock | undefined
}

/** Inline text carried by a block, used to decide if a comment can anchor. */
function blockText(block: AnyBlock): string {
  const content = block.content
  if (!Array.isArray(content)) return ''
  return content
    .map((node) => (typeof node === 'object' && node && 'text' in node ? String(node.text) : ''))
    .join('')
}

/** True when the block embeds a vault attachment, block-level or inline. */
function carriesAttachment(block: AnyBlock): boolean {
  if (ATTACHMENT_BLOCK_TYPES.has(block.type)) return true
  const content = block.content
  if (!Array.isArray(content)) return false
  return content.some(
    (node) =>
      typeof node === 'object' &&
      node !== null &&
      (node as { type?: string }).type === 'inlineImage'
  )
}

/**
 * ProseMirror range covering a block's inline content.
 *
 * A block container node carries the block id; its first textblock descendant
 * holds the inline content the comment must wrap.
 */
function findBlockInlineRange(
  doc: ProseMirrorNode,
  blockId: string
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null

  doc.descendants((node, pos) => {
    if (found) return false
    if ((node.attrs as { id?: string } | undefined)?.id !== blockId) return true

    node.descendants((child, childPos) => {
      if (found || !child.isTextblock) return !found
      const from = pos + 1 + childPos + 1
      found = { from, to: from + child.content.size }
      return false
    })
    return false
  })

  return found
}

function MenuItem({
  icon,
  label,
  shortcut,
  onClick
}: {
  icon: ReactNode
  label: string
  shortcut?: string
  onClick: () => void
}) {
  const Components = useComponentsContext()!
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" icon={icon} onClick={onClick}>
      {label}
      {shortcut ? (
        <span className="bn-menu-item-shortcut ms-auto ps-4 opacity-60">{shortcut}</span>
      ) : null}
    </Components.Generic.Menu.Item>
  )
}

function TurnIntoItem() {
  const { t } = useT('notes')
  const Components = useComponentsContext()!
  const editor = useBlockNoteEditor<any, any, any>()
  const block = useCurrentBlock()

  if (!block || NON_TEXT_BLOCK_TYPES.has(block.type)) return null

  // Only offer types this editor's schema actually carries — the note body and
  // the task/inbox editors do not share a schema.
  const targets = TURN_INTO_TARGETS.filter((target) =>
    Boolean(editor.schema.blockSchema[target.type])
  )
  if (targets.length === 0) return null

  return (
    <Components.Generic.Menu.Root position="right" sub={true}>
      <Components.Generic.Menu.Trigger sub={true}>
        <Components.Generic.Menu.Item
          className="bn-menu-item"
          icon={<Type size={16} />}
          subTrigger={true}
        >
          {t('editor.blockMenu.turnInto')}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub={true} className="bn-menu-dropdown">
        {targets.map((target) => (
          <Components.Generic.Menu.Item
            key={target.key}
            className="bn-menu-item"
            onClick={() => {
              // `updateBlock` keeps `children`, so an indented sub-list survives
              // the conversion instead of being silently dropped.
              editor.updateBlock(block, { type: target.type, props: target.props ?? {} })
            }}
          >
            {t(`editor.blockMenu.turnIntoTypes.${target.key}`)}
          </Components.Generic.Menu.Item>
        ))}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  )
}

function DuplicateItem() {
  const { t } = useT('notes')
  const editor = useBlockNoteEditor<any, any, any>()
  const block = useCurrentBlock()

  const duplicate = useCallback(() => {
    if (!block) return
    duplicateBlock(editor, block.id)
  }, [editor, block])

  if (!block) return null

  return (
    <MenuItem
      icon={<Copy size={16} />}
      label={t('editor.blockMenu.duplicate')}
      shortcut={duplicateShortcutLabel()}
      onClick={duplicate}
    />
  )
}

function MoveToItem({ onRequestMove }: { onRequestMove?: (blockId: string) => void }) {
  const { t } = useT('notes')
  const block = useCurrentBlock()

  if (!block || !onRequestMove) return null
  // Moving an attachment-bearing block would break the embed on every other
  // device; the item is hidden rather than shown failing.
  if (carriesAttachment(block)) return null

  return (
    <MenuItem
      icon={<ArrowRight size={16} />}
      label={t('editor.blockMenu.moveTo')}
      onClick={() => onRequestMove(block.id)}
    />
  )
}

function CommentItem({ onAddComment }: { onAddComment?: (selection: ReviewSelection) => void }) {
  const { t } = useT('notes')
  const editor = useBlockNoteEditor<any, any, any>()
  const block = useCurrentBlock()

  const addComment = useCallback(() => {
    if (!block || !onAddComment) return
    const typed = editor as unknown as BlockNoteEditor
    const state = getProseMirrorState(typed)
    const view = (editor as { prosemirrorView?: { dispatch: (tr: unknown) => void } })
      .prosemirrorView
    const range = findBlockInlineRange(state.doc, block.id)
    if (!range || range.to <= range.from || !view) return

    // The review composer anchors to a ProseMirror range, so select the block's
    // text first and then read the selection back through the same helper the
    // formatting toolbar's comment button uses.
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, range.from, range.to)))
    onAddComment(getEditorSelectionFromState(typed, getProseMirrorState(typed)))
  }, [editor, block, onAddComment])

  if (!block || !onAddComment) return null
  if (NON_TEXT_BLOCK_TYPES.has(block.type)) return null
  if (!blockText(block).trim()) return null

  return (
    <MenuItem
      icon={<MessageCircle size={16} />}
      label={t('editor.blockMenu.comment')}
      onClick={addComment}
    />
  )
}

/**
 * Duplicate a block and its subtree, inserting the copy directly below.
 *
 * Exported so the ⌘D editor plugin and the menu item share one implementation.
 */
export function duplicateBlock(editor: any, blockId: string): boolean {
  const block = editor.getBlock(blockId)
  if (!block) return false
  // `id` is stripped from the copy (and from every descendant) so BlockNote
  // mints fresh ones; reusing them would collide with the original.
  const stripIds = (node: any): any => ({
    ...node,
    id: undefined,
    children: Array.isArray(node.children) ? node.children.map(stripIds) : node.children
  })
  editor.insertBlocks([stripIds(block)], block, 'after')
  return true
}

export function duplicateShortcutLabel(): string {
  return isMac ? '⌘D' : 'Ctrl+D'
}

export interface BlockSideMenuProps {
  /** Opens the review comment composer; omitted where review is not wired. */
  onAddComment?: (selection: ReviewSelection) => void
  /** Opens the "move block to another note" picker for the given block. */
  onRequestMove?: (blockId: string) => void
}

/**
 * Mount inside `<BlockNoteView>` to replace the stock side menu.
 *
 * `SideMenuController` renders its `sideMenu` component with no props, so the
 * handlers are closed over here rather than threaded through BlockNote.
 */
export function BlockSideMenuController({ onAddComment, onRequestMove }: BlockSideMenuProps) {
  const { t } = useT('notes')

  const dragHandleMenu = useMemo<FC>(
    () => () => <MemryDragHandleMenu onAddComment={onAddComment} onRequestMove={onRequestMove} />,
    [onAddComment, onRequestMove]
  )

  const sideMenu = useMemo<FC>(
    () => () => <SideMenu dragHandleMenu={dragHandleMenu} />,
    [dragHandleMenu]
  )

  // `t` is read here only so the menu re-renders on a language change; the
  // labels themselves are resolved inside each item.
  void t

  return <SideMenuController sideMenu={sideMenu} />
}

function MemryDragHandleMenu({ onAddComment, onRequestMove }: BlockSideMenuProps) {
  const { t } = useT('notes')
  const Components = useComponentsContext()!

  return (
    <Components.Generic.Menu.Dropdown className="bn-menu-dropdown bn-drag-handle-menu">
      <TurnIntoItem />
      {/* Stock item: owns the block colour props, their markdown marker and the
          `text-color-*` test hooks. The label stays BlockNote's "Colors" so the
          existing drag-handle E2E keeps matching it. */}
      <BlockColorsItem>
        <span className="flex items-center gap-2">
          <Palette size={16} aria-hidden />
          {t('editor.blockMenu.colors')}
        </span>
      </BlockColorsItem>
      <Components.Generic.Menu.Divider />
      <DuplicateItem />
      <MoveToItem onRequestMove={onRequestMove} />
      <RemoveBlockItem>
        <span className="flex items-center gap-2">
          <Trash2 size={16} aria-hidden />
          {t('editor.blockMenu.delete')}
        </span>
      </RemoveBlockItem>
      <Components.Generic.Menu.Divider />
      <CommentItem onAddComment={onAddComment} />
    </Components.Generic.Menu.Dropdown>
  )
}
