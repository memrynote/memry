import { useMemo } from 'react'
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
import { MoreHorizontal } from '@/lib/icons'
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

export function CompactSelectionFormattingToolbar() {
  const { t } = useT('notes')

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
      </div>
    </FormattingToolbar>
  )
}
