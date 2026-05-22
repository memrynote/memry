import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import { editorHasBlockWithType } from '@blocknote/core'
import { RiQuoteText } from 'react-icons/ri'
import {
  BasicTextStyleButton,
  ColorStyleButton,
  CreateLinkButton,
  FormattingToolbar,
  NestBlockButton,
  TextAlignButton,
  UnnestBlockButton,
  blockTypeSelectItems,
  useBlockNoteEditor,
  useEditorState,
  type BlockTypeSelectItem
} from '@blocknote/react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { CommentAdd, MoreHorizontal } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

const CALLOUT_TURN_INTO_ITEM: BlockTypeSelectItem = {
  name: 'Callout',
  type: 'callout',
  props: { type: 'info' },
  icon: RiQuoteText
}

function propsToSchemaTypes(
  item: BlockTypeSelectItem
): Record<string, 'boolean' | 'number' | 'string'> {
  return Object.fromEntries(
    Object.entries(item.props ?? {}).map(([propName, propValue]) => [
      propName,
      typeof propValue as 'boolean' | 'number' | 'string'
    ])
  )
}

function isCurrentBlockType(
  item: BlockTypeSelectItem,
  block: { type: string; props: Record<string, unknown> }
) {
  if (item.type !== block.type) return false

  return Object.entries(item.props ?? {}).every(
    ([propName, propValue]) => block.props[propName] === propValue
  )
}

function TurnIntoMenu() {
  const { t } = useT('notes')
  const editor = useBlockNoteEditor()

  const selectedBlocks = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor.getSelection()?.blocks || [editor.getTextCursorPosition().block]
  })
  const firstSelectedBlock = selectedBlocks[0]

  const items = useMemo(() => {
    const baseItems = blockTypeSelectItems(editor.dictionary)
    const customItems = editorHasBlockWithType(editor, CALLOUT_TURN_INTO_ITEM.type)
      ? [CALLOUT_TURN_INTO_ITEM]
      : []

    return [...baseItems, ...customItems].filter((item) =>
      editorHasBlockWithType(editor, item.type, propsToSchemaTypes(item))
    )
  }, [editor])

  const turnInto = (item: BlockTypeSelectItem) => {
    editor.focus()
    editor.transact(() => {
      for (const block of selectedBlocks) {
        editor.updateBlock(block, {
          type: item.type,
          props: item.props
        } as Parameters<typeof editor.updateBlock>[1])
      }
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('editor.selectionToolbar.moreOptions')}
          className={cn(
            'bn-button inline-flex h-8 min-w-8 items-center justify-center rounded-md px-0',
            'text-popover-foreground hover:bg-accent hover:text-accent-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          )}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="w-48">
        <DropdownMenuLabel>{t('editor.selectionToolbar.turnInto')}</DropdownMenuLabel>
        {items.map((item) => {
          const Icon = item.icon
          return (
            <DropdownMenuItem
              key={`${item.type}-${JSON.stringify(item.props ?? {})}`}
              onClick={() => turnInto(item)}
              className={cn(
                'gap-2',
                isCurrentBlockType(item, firstSelectedBlock) && 'bg-accent text-accent-foreground'
              )}
            >
              <Icon className="size-4" />
              {item.name}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface CompactSelectionFormattingToolbarProps {
  canComment?: boolean
  onComment?: () => void
}

const SelectionCommentToolbarContext = createContext<CompactSelectionFormattingToolbarProps>({})

export function SelectionCommentToolbarProvider({
  canComment = false,
  onComment,
  children
}: CompactSelectionFormattingToolbarProps & { children: ReactNode }) {
  const value = useMemo(() => ({ canComment, onComment }), [canComment, onComment])

  return (
    <SelectionCommentToolbarContext.Provider value={value}>
      {children}
    </SelectionCommentToolbarContext.Provider>
  )
}

export function CompactSelectionFormattingToolbar() {
  const { t } = useT('notes')
  const { canComment = false, onComment } = useContext(SelectionCommentToolbarContext)
  const bindCommentButton = useCallback(
    (button: HTMLButtonElement | null) => {
      if (!button || !onComment) return

      const openFromEvent = (event: MouseEvent | PointerEvent) => {
        event.preventDefault()
        event.stopPropagation()
        onComment()
      }
      let openedFromPointer = false

      const handleKeyboardClick = (event: MouseEvent) => {
        if (event.detail !== 0) return
        openFromEvent(event)
      }

      button.onpointerdown = (event) => {
        openedFromPointer = true
        openFromEvent(event)
      }
      button.onmousedown = (event) => {
        if (openedFromPointer) {
          openedFromPointer = false
          return
        }
        openFromEvent(event)
      }
      button.onclick = handleKeyboardClick
    },
    [onComment]
  )

  return (
    <FormattingToolbar>
      <div
        aria-label={t('editor.selectionToolbar.aria')}
        className={cn(
          'grid w-[148px] grid-cols-4 gap-1',
          '[&_.bn-button]:h-8 [&_.bn-button]:min-w-8 [&_.bn-button]:px-0',
          '[&_.bn-button]:justify-center [&_.bn-button_svg]:size-4'
        )}
      >
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
        <TurnIntoMenu />
        {canComment && onComment && (
          <button
            ref={bindCommentButton}
            type="button"
            data-comment-selection-action
            aria-label={t('editor.selectionToolbar.comment')}
            title={t('editor.selectionToolbar.comment')}
            className={cn(
              'bn-button col-span-4 inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md px-2',
              'text-popover-foreground hover:bg-accent hover:text-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            )}
          >
            <CommentAdd className="size-4" aria-hidden="true" />
            <span className="text-xs">{t('editor.selectionToolbar.comment')}</span>
          </button>
        )}
      </div>
    </FormattingToolbar>
  )
}
