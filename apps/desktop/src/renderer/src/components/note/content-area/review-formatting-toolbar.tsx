import type { BlockNoteEditor } from '@blocknote/core'
import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react'
import {
  BasicTextStyleButton,
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
import { MessageCircle, PenLine } from '@/lib/icons'
import type { ReviewSelection } from './types'
import { useT } from '@memry/i18n/renderer'

interface ReviewFormattingToolbarProps {
  variant?: 'floating' | 'sticky'
  onAddComment?: (selection: ReviewSelection) => void
  onStartSuggestionMode?: () => void
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
  onStartSuggestionMode,
  ...toolbarProps
}: FormattingToolbarProps & ReviewFormattingToolbarProps) {
  if (variant === 'sticky') {
    return (
      <FormattingToolbar {...toolbarProps}>
        {getFormattingToolbarItems(toolbarProps.blockTypeSelectItems)}
        <ReviewToolbarButton kind="comment" onSelect={onAddComment} />
        <ReviewToolbarButton kind="suggestion" onStartSuggestionMode={onStartSuggestionMode} />
      </FormattingToolbar>
    )
  }

  return (
    <FormattingToolbar {...toolbarProps}>
      <div className="review-formatting-toolbar-compact">
        <div className="review-formatting-toolbar-grid">
          <BasicTextStyleButton basicTextStyle="bold" />
          <BasicTextStyleButton basicTextStyle="italic" />
          <BasicTextStyleButton basicTextStyle="underline" />
          <BasicTextStyleButton basicTextStyle="strike" />
          <TextAlignButton textAlignment="left" />
          <TextAlignButton textAlignment="center" />
          <TextAlignButton textAlignment="right" />
          <ColorStyleButton />
          <NestBlockButton />
          <UnnestBlockButton />
          <CreateLinkButton />
        </div>
        <div className="review-formatting-toolbar-actions">
          <ReviewToolbarButton kind="comment" onSelect={onAddComment} />
          <ReviewToolbarButton kind="suggestion" onStartSuggestionMode={onStartSuggestionMode} />
        </div>
      </div>
    </FormattingToolbar>
  )
}

function ReviewToolbarButton({
  kind,
  onSelect,
  onStartSuggestionMode
}: {
  kind: 'comment' | 'suggestion'
  onSelect?: (selection: ReviewSelection) => void
  onStartSuggestionMode?: () => void
}) {
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
    lastSelectionRef.current = null
  } else {
    const selected = getSelectableSelection(selectionState.selection)
    if (selected) {
      lastSelectionRef.current = selected
    }
  }

  useEffect(() => {
    if (kind !== 'comment') return

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
  }, [editor, kind])

  if (!Components) return null
  if (kind === 'comment' && !onSelect) return null
  if (kind === 'suggestion' && !onStartSuggestionMode) return null

  const label = kind === 'comment' ? t('comments.toolbarComment') : t('comments.toolbarSuggest')
  const Icon = kind === 'comment' ? MessageCircle : PenLine
  const renderSelection =
    getSelectableSelection(selectionState.selection) ??
    getSelectableSelection(lastSelectionRef.current)
  const isDisabled = kind === 'comment' && !renderSelection

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
    if (kind === 'suggestion') {
      onStartSuggestionMode?.()
      return true
    }

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
    if (kind !== 'comment') return
    event.preventDefault()
    if (ignoreNextClickRef.current) return
    if (runAction()) {
      markPointerHandled()
    }
  }

  return (
    <span
      onPointerDownCapture={handlePreClickSelection}
      onMouseDownCapture={handlePreClickSelection}
      onPointerDown={handlePreClickSelection}
      onMouseDown={handlePreClickSelection}
    >
      <Components.FormattingToolbar.Button
        className="bn-button"
        data-test={kind === 'comment' ? 'review-comment' : 'review-suggest'}
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
      />
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

function getEditorSelectionFromState(editor: BlockNoteEditor, state: any): ReviewSelection {
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

function getProseMirrorState(editor: BlockNoteEditor) {
  return (editor as any)._tiptapEditor?.state ?? (editor as any).prosemirrorState
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

function getProseMirrorView(editor: BlockNoteEditor) {
  return (editor as any)._tiptapEditor?.view ?? (editor as any).prosemirrorView
}

function getProseMirrorViewDom(editor: BlockNoteEditor): HTMLElement | undefined {
  return getProseMirrorView(editor)?.dom as HTMLElement | undefined
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
