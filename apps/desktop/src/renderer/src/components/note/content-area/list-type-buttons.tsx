import { useBlockNoteEditor, useComponentsContext, useEditorState } from '@blocknote/react'
import { List, ListChecks, ListOrdered } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import {
  canToggleListType,
  isListTypeActive,
  toggleListType,
  type ListBlockType
} from './list-type-conversion'

const LIST_BUTTONS: Array<{
  type: ListBlockType
  icon: typeof List
  labelKey: 'editor.list.bulleted' | 'editor.list.numbered' | 'editor.list.checklist'
  testId: string
}> = [
  {
    type: 'bulletListItem',
    icon: List,
    labelKey: 'editor.list.bulleted',
    testId: 'list-type-bulleted'
  },
  {
    type: 'numberedListItem',
    icon: ListOrdered,
    labelKey: 'editor.list.numbered',
    testId: 'list-type-numbered'
  },
  {
    type: 'checkListItem',
    icon: ListChecks,
    labelKey: 'editor.list.checklist',
    testId: 'list-type-checklist'
  }
]

/**
 * Bulleted / numbered / checklist toggles for the formatting toolbar.
 *
 * The block type dropdown next to them can already retype a whole selection,
 * but it is labelled with the block's current type ("Paragraph"), so people
 * looking for bullets never open it — see issue #1206. These give the same
 * transform a visible, single-click home on the toolbar that appears the moment
 * text is selected.
 */
export function ListTypeButtons() {
  const { t } = useT('notes')
  const Components = useComponentsContext()
  const editor = useBlockNoteEditor()
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      canToggle: canToggleListType(editor),
      active: LIST_BUTTONS.filter((button) => isListTypeActive(editor, button.type)).map(
        (button) => button.type
      )
    })
  })

  if (!Components) return null

  return (
    <>
      {LIST_BUTTONS.map(({ type, icon: Icon, labelKey, testId }) => {
        const label = t(labelKey)
        return (
          <Components.FormattingToolbar.Button
            key={type}
            className="bn-button"
            data-test={testId}
            label={label}
            mainTooltip={label}
            isDisabled={!state.canToggle}
            isSelected={state.active.includes(type)}
            icon={<Icon size={16} />}
            onClick={() => toggleListType(editor, type)}
          />
        )
      })}
    </>
  )
}
