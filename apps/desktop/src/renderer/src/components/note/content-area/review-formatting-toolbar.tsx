import type { BlockNoteEditor } from '@blocknote/core'
import { useRef, type MouseEvent, type PointerEvent } from 'react'
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
  const selectionState = useEditorState({
    editor,
    selector: ({ editor }) => {
      const state = getProseMirrorState(editor as BlockNoteEditor)
      const selection = state.selection
      if (selection.empty) return { hasSelection: false, isMultiBlock: false }
      const text = state.doc.textBetween(selection.from, selection.to, '\n')
      return { hasSelection: true, isMultiBlock: text.includes('\n') }
    }
  })

  if (!Components) return null
  if (kind === 'comment' && !onSelect) return null
  if (kind === 'suggestion' && !onStartSuggestionMode) return null

  const label = kind === 'comment' ? t('comments.toolbarComment') : t('comments.toolbarSuggest')
  const Icon = kind === 'comment' ? MessageCircle : PenLine
  const isDisabled =
    kind === 'comment' && (!selectionState.hasSelection || selectionState.isMultiBlock)

  const runAction = () => {
    if (kind === 'suggestion') {
      onStartSuggestionMode?.()
      return
    }

    const selection = getEditorSelection(editor)
    if (selection.isEmpty) return
    onSelect?.(selection)
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
    if (kind !== 'comment' || isDisabled) return
    event.preventDefault()
    if (ignoreNextClickRef.current) return
    markPointerHandled()
    runAction()
  }

  return (
    <span onPointerDown={handlePreClickSelection} onMouseDown={handlePreClickSelection}>
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

function getEditorSelection(editor: BlockNoteEditor): ReviewSelection {
  const state = getProseMirrorState(editor)
  const selection = state.selection
  if (selection.empty) return { text: '', isEmpty: true }

  return {
    text: state.doc.textBetween(selection.from, selection.to, '\n').trim(),
    isEmpty: false,
    from: selection.from,
    to: selection.to
  }
}

function getProseMirrorState(editor: BlockNoteEditor) {
  return (editor as any)._tiptapEditor?.state ?? (editor as any).prosemirrorState
}
