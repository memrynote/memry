import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import { RelationPickerCell, useTagTable } from '@/features/tag-fields/tag-table'
import { EditablePropertyCell } from './property-cell'
import { isMetadataEditableRow } from './row-metadata-editability'
import type { PropertyType } from './property-cell'

export function FieldPropertyCell({
  note,
  columnId,
  value,
  type,
  highlightQuery,
  onPropertyUpdate
}: {
  note: NoteWithProperties
  columnId: string
  value: unknown
  type: PropertyType
  highlightQuery?: string
  onPropertyUpdate?: (noteId: string, propertyId: string, value: unknown) => void
}): React.JSX.Element {
  const table = useTagTable()
  const isField = table?.isFieldColumn(columnId) ?? false
  const editable =
    onPropertyUpdate !== undefined &&
    (isMetadataEditableRow(note) || (isField && note.kind === 'task'))
  const save = editable
    ? (nextValue: unknown) => onPropertyUpdate(note.id, columnId, nextValue)
    : undefined

  const target = isField ? table?.relationTargetOf(columnId) : null
  if (target && save) {
    const many = table?.tag.effectiveFields.find((f) => f.name === columnId)?.relation?.many ?? true
    return <RelationPickerCell value={value} target={target} many={many} onSave={save} />
  }
  return (
    <EditablePropertyCell value={value} type={type} highlightQuery={highlightQuery} onSave={save} />
  )
}
