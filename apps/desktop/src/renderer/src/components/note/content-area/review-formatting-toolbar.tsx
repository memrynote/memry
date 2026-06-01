import type { BlockNoteEditor } from '@blocknote/core'
import { useRef, type MouseEvent, type PointerEvent } from 'react'
import {
  BasicTextStyleButton,
  blockTypeSelectItems as defaultBlockTypeSelectItems,
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
  type BlockTypeSelectItem,
  type FormattingToolbarProps
} from '@blocknote/react'
import { ChevronDown, MessageCircle, PenLine } from '@/lib/icons'
import type { ReviewSelection } from './types'
import { useT } from '@memry/i18n/renderer'

type ReviewFormattingToolbarVariant = 'floating' | 'sticky'

interface ReviewFormattingToolbarProps {
  variant?: ReviewFormattingToolbarVariant
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
        <ReviewBlockTypeMenu blockTypeSelectItems={toolbarProps.blockTypeSelectItems} />
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

function ReviewBlockTypeMenu({
  blockTypeSelectItems
}: {
  blockTypeSelectItems?: BlockTypeSelectItem[]
}) {
  const Components = useComponentsContext()
  const editor = useBlockNoteEditor()
  const selectedBlocks = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor.getSelection()?.blocks || [editor.getTextCursorPosition().block]
  })
  const firstSelectedBlock = selectedBlocks[0]

  if (!Components || !editor.isEditable || !firstSelectedBlock) return null

  const items = blockTypeSelectItems ?? defaultBlockTypeSelectItems(editor.dictionary)
  const selectedItem =
    items.find((item) => {
      const typeMatches = item.type === firstSelectedBlock.type
      const propsMatch = Object.entries(item.props || {}).every(
        ([propName, propValue]) => firstSelectedBlock.props[propName] === propValue
      )

      return typeMatches && propsMatch
    }) ?? items[0]

  if (!selectedItem) return null

  const SelectedIcon = selectedItem.icon

  return (
    <Components.Generic.Menu.Root position="bottom-start">
      <Components.Generic.Menu.Trigger>
        <Components.Generic.Menu.Button
          className="bn-button review-block-type-trigger"
          label={selectedItem.name}
        >
          <SelectedIcon size={16} />
          <span className="review-block-type-trigger-label">{selectedItem.name}</span>
          <ChevronDown className="review-block-type-trigger-chevron" />
        </Components.Generic.Menu.Button>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown className="review-formatting-toolbar-menu">
        {items.map((item) => {
          const Icon = item.icon
          const isSelected =
            item.type === firstSelectedBlock.type &&
            Object.entries(item.props || {}).every(
              ([propName, propValue]) => firstSelectedBlock.props[propName] === propValue
            )

          return (
            <Components.Generic.Menu.Item
              key={`${item.type}:${JSON.stringify(item.props ?? {})}`}
              checked={isSelected}
              icon={<Icon size={16} />}
              onClick={() => {
                editor.focus()
                editor.transact(() => {
                  for (const block of selectedBlocks) {
                    editor.updateBlock(block, {
                      type: item.type as any,
                      props: item.props as any
                    })
                  }
                })
              }}
            >
              {item.name}
            </Components.Generic.Menu.Item>
          )
        })}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
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
  const hasSelection = useEditorState({
    editor,
    selector: ({ editor }) => !getProseMirrorState(editor).selection.empty
  })

  if (!Components) return null
  if (kind === 'comment' && !onSelect) return null
  if (kind === 'suggestion' && !onStartSuggestionMode) return null

  const label = kind === 'comment' ? t('comments.toolbarComment') : t('comments.toolbarSuggest')
  const Icon = kind === 'comment' ? MessageCircle : PenLine
  const isDisabled = kind === 'comment' && !hasSelection
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
  return (editor as any)._tiptapEditor?.state ?? editor.prosemirrorState
}
