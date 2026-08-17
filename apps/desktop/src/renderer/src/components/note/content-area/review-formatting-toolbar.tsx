import type { BlockNoteEditor } from '@blocknote/core'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react'
import {
  BasicTextStyleButton,
  BlockTypeSelect,
  ColorStyleButton,
  CreateLinkButton,
  FormattingToolbar,
  FormattingToolbarController,
  getFormattingToolbarItems,
  NestBlockButton,
  TextAlignButton,
  UnnestBlockButton,
  useBlockNoteEditor,
  useComponentsContext,
  useEditorState,
  type FormattingToolbarProps
} from '@blocknote/react'
import { MessageCircle } from '@/lib/icons'
import type { ReviewSelection } from './types'
import { ListTypeButtons } from './list-type-buttons'
import { useT } from '@memry/i18n/renderer'

interface ReviewFormattingToolbarProps {
  variant?: 'floating' | 'sticky'
  onAddComment?: (selection: ReviewSelection) => void
}

export function ReviewFormattingToolbarController(props: ReviewFormattingToolbarProps) {
  return (
    <FormattingToolbarController
      formattingToolbar={(toolbarProps) => (
        <ReviewFormattingToolbar {...toolbarProps} {...props} variant="floating" />
      )}
    />
  )
}

export function ReviewFormattingToolbar({
  variant = 'floating',
  onAddComment,
  ...toolbarProps
}: FormattingToolbarProps & ReviewFormattingToolbarProps) {
  const editor = useBlockNoteEditor()
  // A NodeSelection (e.g. the URL preview/bookmark atom selected via arrow
  // keys) is non-empty but holds no inline text. BlockNote opens the floating
  // toolbar on any non-empty selection, so suppress it here for node
  // selections — otherwise the comment/suggest tooltip pops over the block.
  const isNodeSelection = useEditorState({
    editor,
    selector: ({ editor }) => {
      const state = getProseMirrorState(editor as BlockNoteEditor)
      const selection = state?.selection
      return Boolean(selection && !selection.empty && (selection as { node?: unknown }).node)
    }
  })

  if (variant === 'sticky') {
    return (
      <FormattingToolbar {...toolbarProps}>
        {getFormattingToolbarItems(toolbarProps.blockTypeSelectItems)}
        <ListTypeButtons />
        <ReviewToolbarButton onSelect={onAddComment} />
      </FormattingToolbar>
    )
  }

  if (isNodeSelection) return null

  return (
    <FormattingToolbar {...toolbarProps}>
      <div className="review-formatting-toolbar-compact">
        {/* Block type (paragraph/heading/list) is the sticky toolbar's first
            item. Without it here, turning the sticky toolbar off left no way to
            restyle a block from the selection popup. Renders null for blocks
            outside the block type list (task blocks, callouts, files); the row
            collapses via `:empty` so it costs no space then. */}
        <div className="review-formatting-toolbar-block-type">
          <BlockTypeSelect items={toolbarProps.blockTypeSelectItems} />
        </div>
        <div className="review-formatting-toolbar-grid">
          <BasicTextStyleButton basicTextStyle="bold" />
          <BasicTextStyleButton basicTextStyle="italic" />
          <BasicTextStyleButton basicTextStyle="underline" />
          <BasicTextStyleButton basicTextStyle="strike" />
          {/* Inline code (the backtick style) is in the schema and in the
              markdown round-trip, but no toolbar surfaced it — the only way in
              was typing backticks. */}
          <BasicTextStyleButton basicTextStyle="code" />
          {/* Turning selected lines into a list is the reason most people open
              this popup (#1206), so the toggles sit next to the text styles
              rather than behind the "Paragraph" dropdown above. */}
          <ListTypeButtons />
          <TextAlignButton textAlignment="left" />
          <TextAlignButton textAlignment="center" />
          <TextAlignButton textAlignment="right" />
          <ColorStyleButton />
          <NestBlockButton />
          <UnnestBlockButton />
          <CreateLinkButton />
        </div>
        <div className="review-formatting-toolbar-actions">
          <ReviewToolbarButton onSelect={onAddComment} />
        </div>
      </div>
    </FormattingToolbar>
  )
}

function ReviewToolbarButton({ onSelect }: { onSelect?: (selection: ReviewSelection) => void }) {
  const { t } = useT('notes')
  const Components = useComponentsContext()
  const editor = useBlockNoteEditor()
  const ignoreNextClickRef = useRef(false)
  const lastSelectionRef = useRef<ReviewSelection | null>(null)
  const selectionState = useEditorState({
    editor,
    selector: ({ editor }) => {
      const state = getProseMirrorState(editor as BlockNoteEditor)
      const selection = state.selection
      if (selection.empty) {
        const domSelection = getDomEditorSelection(editor as BlockNoteEditor)
        return {
          hasSelection: Boolean(domSelection),
          isMultiBlock: (domSelection?.text ?? '').includes('\n'),
          selection: domSelection
        }
      }
      const text = state.doc.textBetween(selection.from, selection.to, '\n')
      const reviewSelection = getEditorSelectionFromState(editor as BlockNoteEditor, state)
      const selectedText = reviewSelection.text.length > 0 ? reviewSelection.text : text.trim()
      const domSelection = getDomEditorSelection(editor as BlockNoteEditor)
      const activeSelection =
        selectedText.length > 0 && !selectedText.includes('\n')
          ? reviewSelection
          : (domSelection ?? (selectedText.length > 0 ? reviewSelection : null))
      return {
        hasSelection: Boolean(activeSelection),
        isMultiBlock: (activeSelection?.text ?? text).includes('\n'),
        selection: activeSelection
      }
    }
  })
  if (selectionState.isMultiBlock) {
    // Caches last single-block selection across renders so the comment button
    // can reopen on a selection BlockNote has already cleared.
    lastSelectionRef.current = null
  } else {
    const selected = getSelectableSelection(selectionState.selection)
    if (selected) {
      // Same selection cache; persists the prior frame's selection.
      lastSelectionRef.current = selected
    }
  }

  useEffect(() => {
    const rememberDomSelection = () => {
      window.setTimeout(() => {
        const domSelection = getDomEditorSelection(editor)
        if (!domSelection) {
          if (hasMultiBlockDomSelection(editor)) {
            lastSelectionRef.current = null
          }
          return
        }
        if (
          !domSelection.isEmpty &&
          domSelection.text.trim() &&
          !domSelection.text.includes('\n')
        ) {
          lastSelectionRef.current = domSelection
        }
      }, 0)
    }

    document.addEventListener('selectionchange', rememberDomSelection)
    window.addEventListener('mouseup', rememberDomSelection)
    window.addEventListener('pointerup', rememberDomSelection)
    rememberDomSelection()

    return () => {
      document.removeEventListener('selectionchange', rememberDomSelection)
      window.removeEventListener('mouseup', rememberDomSelection)
      window.removeEventListener('pointerup', rememberDomSelection)
    }
  }, [editor])

  if (!Components) return null
  if (!onSelect) return null

  const label = t('comments.toolbarComment')
  const Icon = MessageCircle
  // Reads cached last single-block selection (written above) as a render fallback.
  const cachedSelection = getSelectableSelection(lastSelectionRef.current)
  const renderSelection = getSelectableSelection(selectionState.selection) ?? cachedSelection
  const isDisabled = !renderSelection

  const getActionSelection = (): ReviewSelection | null => {
    const hasMultiBlockSelection = hasMultiBlockDomSelection(editor)
    if (hasMultiBlockSelection) {
      return null
    }

    const currentSelection = getEditorSelection(editor)
    const domSelection = getDomEditorSelection(editor)
    const selection =
      getSelectableSelection(currentSelection) ??
      getSelectableSelection(selectionState.selection) ??
      getSelectableSelection(lastSelectionRef.current) ??
      getSelectableSelection(domSelection)
    return selection
  }

  const runAction = (): boolean => {
    const selection = getActionSelection()
    if (!selection) {
      return false
    }

    onSelect?.(selection)
    return true
  }

  const markPointerHandled = () => {
    ignoreNextClickRef.current = true
    window.setTimeout(() => {
      ignoreNextClickRef.current = false
    }, 0)
  }

  const handlePreClickSelection = (
    event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>
  ): void => {
    event.preventDefault()
    if (ignoreNextClickRef.current) return
    if (runAction()) {
      markPointerHandled()
    }
  }

  return (
    <span
      className="review-formatting-toolbar-action"
      onPointerDownCapture={handlePreClickSelection}
      onMouseDownCapture={handlePreClickSelection}
      onPointerDown={handlePreClickSelection}
      onMouseDown={handlePreClickSelection}
    >
      <Components.FormattingToolbar.Button
        className="bn-button"
        data-test="review-comment"
        label={label}
        mainTooltip={label}
        isDisabled={isDisabled}
        icon={<Icon size={16} />}
        onClick={() => {
          if (ignoreNextClickRef.current) {
            ignoreNextClickRef.current = false
            return
          }
          runAction()
        }}
      >
        {/* The icon alone read as an unlabelled glyph in the corner of the
            popup; the row is a single full-width button so the action is
            spelled out. `label` stays for the aria-label. */}
        {label}
      </Components.FormattingToolbar.Button>
    </span>
  )
}

function getSelectableSelection(
  selection: ReviewSelection | null | undefined
): ReviewSelection | null {
  if (!selection) return null
  const text = selection.text.trim()
  if (selection.isEmpty || !text || text.includes('\n')) return null
  return { ...selection, text, isEmpty: false }
}

function getEditorSelection(editor: BlockNoteEditor): ReviewSelection {
  const state = getProseMirrorState(editor)
  return getEditorSelectionFromState(editor, state)
}

function getEditorSelectionFromState(editor: BlockNoteEditor, state: EditorState): ReviewSelection {
  const selection = state.selection
  if (selection.empty) return { text: '', isEmpty: true }

  return {
    text: state.doc.textBetween(selection.from, selection.to, '\n').trim(),
    isEmpty: false,
    top: getSelectionTop(editor, selection.from),
    from: selection.from,
    to: selection.to
  }
}

type TiptapHost = {
  _tiptapEditor?: { state?: EditorState; view?: EditorView; editorView?: EditorView }
  prosemirrorState?: EditorState
  prosemirrorView?: EditorView
}

function getProseMirrorState(editor: BlockNoteEditor): EditorState {
  const host = editor as unknown as TiptapHost
  return (host._tiptapEditor?.state ?? host.prosemirrorState) as EditorState
}

function getSelectionTop(editor: BlockNoteEditor, from: number): number | undefined {
  const view = getProseMirrorView(editor)
  const viewDom = getProseMirrorViewDom(editor)
  if (!viewDom || typeof view?.coordsAtPos !== 'function') return undefined

  try {
    const root = viewDom.closest<HTMLElement>('.marquee-zone')
    if (!root) return undefined

    const coords = view.coordsAtPos(from)
    return Math.max(0, coords.top - root.getBoundingClientRect().top)
  } catch {
    return undefined
  }
}

function getDomEditorSelection(editor: BlockNoteEditor): ReviewSelection | null {
  const viewDom = getProseMirrorViewDom(editor)
  const selection = window.getSelection()
  if (!viewDom || !selection || selection.isCollapsed || selection.rangeCount === 0) return null
  if (!selection.anchorNode || !selection.focusNode) return null
  if (!viewDom.contains(selection.anchorNode) || !viewDom.contains(selection.focusNode)) return null

  const text = selection.toString().trim()
  if (!text) return null

  const range = selection.getRangeAt(0)
  const rect =
    Array.from(range.getClientRects()).find((item) => item.width > 0 && item.height > 0) ??
    range.getBoundingClientRect()
  const root = viewDom.closest<HTMLElement>('.marquee-zone')
  const top =
    root && rect.width > 0 && rect.height > 0
      ? Math.max(0, rect.top - root.getBoundingClientRect().top)
      : undefined

  return {
    text,
    isEmpty: false,
    ...(top !== undefined ? { top } : {})
  }
}

function getProseMirrorView(editor: BlockNoteEditor): EditorView | undefined {
  const host = editor as unknown as TiptapHost
  const tiptap = host._tiptapEditor
  // TipTap 3.x `editor.view` returns a Proxy that THROWS on any property access
  // (e.g. `.dom`) until the ProseMirror view is mounted, so `view?.dom` can't
  // short-circuit — the Proxy is non-null. `editorView` is the real view and is
  // only set once mounted; guard on it so reads during the pre-mount render
  // window get `undefined` instead of crashing the editor (issue #541).
  if (tiptap && !tiptap.editorView) return undefined
  return tiptap?.view ?? host.prosemirrorView
}

function getProseMirrorViewDom(editor: BlockNoteEditor): HTMLElement | undefined {
  return getProseMirrorView(editor)?.dom
}

function hasMultiBlockDomSelection(editor: BlockNoteEditor): boolean {
  const viewDom = getProseMirrorViewDom(editor)
  const selection = window.getSelection()
  if (!viewDom || !selection || selection.isCollapsed) return false
  if (!selection.anchorNode || !selection.focusNode) return false
  if (!viewDom.contains(selection.anchorNode) || !viewDom.contains(selection.focusNode))
    return false

  return selection.toString().trim().includes('\n')
}
