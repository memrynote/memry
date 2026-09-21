/**
 * Decode an Apple Notes table attachment into a markdown table.
 *
 * A table is not stored in the note body. The body only carries an inline
 * attachment run whose UTI is `com.apple.notes.table`; the grid itself lives on
 * that ICAttachment row in ZMERGEABLEDATA1 as a gzipped `MergableDataProto` —
 * the CRDT Apple uses so two devices can edit the same table.
 *
 * Nothing in that payload is stored positionally. It is a flat list of objects
 * plus three lookup lists (keys, types, uuids), and every reference is an index
 * into one of them:
 *
 *   root (customMap, type = com.apple.notes.ICTable)
 *     ├─ crRows      → orderedSet: row uuids in display order
 *     ├─ crColumns   → orderedSet: column uuids in display order
 *     └─ cellColumns → dictionary: column uuid → (dictionary: row uuid → note)
 *
 * So a cell's position comes from resolving its column/row uuid through the two
 * ordered sets, and its text is an ordinary `Note` message — the same shape a
 * note body has, which is why cells reuse the note converter.
 *
 * The decode is pure (no zlib, no sqlite): the desktop importer gunzips the
 * blob and hands the protobuf bytes over.
 */

import { MERGEABLE_DATA_TYPE } from './descriptor.ts'
import { lookupAppleNotesType } from './root.ts'
import { noteToCellMarkdown } from './convert-doc.ts'
import { AN_TABLE_KEY, AN_TABLE_TYPE } from './types.ts'
import type {
  ANMergeableData,
  ANMergeableObject,
  ANObjectId,
  ANOrderedSet,
  DecodedTable
} from './types.ts'

/** uuid bytes → hex, the key rows/columns are matched by. */
function uuidToHex(uuid: Uint8Array | undefined): string {
  if (!uuid) return ''
  let out = ''
  for (const byte of uuid) out += byte.toString(16).padStart(2, '0')
  return out
}

/** Row/column uuid (hex) → its index in the table. */
type UuidPositions = Map<string, number>

/**
 * Resolve the uuid a reference points at. The reference names an NSUUID wrapper
 * object, which holds an index into the payload's uuid list — two hops, because
 * the CRDT stores every uuid once and references it everywhere else.
 */
function targetUuid(
  reference: ANObjectId | undefined,
  objects: ANMergeableObject[],
  keys: string[],
  uuids: string[]
): string {
  const wrapper = reference?.objectIndex != null ? objects[reference.objectIndex] : undefined
  const entry = wrapper?.customMap?.mapEntry?.find(
    (candidate) => keys[candidate.key ?? -1] === AN_TABLE_KEY.UuidIndex
  )
  const index = entry?.value?.unsignedIntegerValue
  return index != null ? (uuids[index] ?? '') : ''
}

/**
 * Positions of the rows (or columns) of a table from their ordered set: the
 * `array` holds the uuids in display order, and `ordering.contents` maps each
 * of those to the uuid the cell dictionaries are keyed by.
 */
function orderedPositions(
  orderedSet: ANOrderedSet | undefined,
  objects: ANMergeableObject[],
  keys: string[],
  uuids: string[]
): { positions: UuidPositions; count: number } {
  const ordering = (orderedSet?.ordering?.array?.attachment ?? []).map((attachment) =>
    uuidToHex(attachment.uuid)
  )
  const positions: UuidPositions = new Map()
  for (const element of orderedSet?.ordering?.contents?.element ?? []) {
    const position = ordering.indexOf(targetUuid(element.key, objects, keys, uuids))
    if (position < 0) continue
    positions.set(targetUuid(element.value, objects, keys, uuids), position)
  }
  return { positions, count: ordering.length }
}

/**
 * Decode a table attachment's (already gunzipped) mergeable-data protobuf.
 *
 * Returns `null` when the payload carries no table we can rebuild — an unknown
 * layout, or a root without cell data. Callers treat that as "not a table" and
 * leave the note body alone rather than writing half a grid.
 */
export function decodeTable(protobufBytes: Uint8Array): DecodedTable | null {
  const MergableDataProto = lookupAppleNotesType(MERGEABLE_DATA_TYPE)
  const message = MergableDataProto.decode(protobufBytes)
  const decoded = MergableDataProto.toObject(message, {
    // uint64 uuid/type indices are small; a Long here would break array lookups.
    longs: Number,
    arrays: true,
    objects: true
  }) as { mergableDataObject?: { mergeableDataObjectData?: ANMergeableData } }

  const data = decoded.mergableDataObject?.mergeableDataObjectData
  if (!data) return null

  const objects = data.mergeableDataObjectEntry ?? []
  const keys = data.mergeableDataObjectKeyItem ?? []
  const types = data.mergeableDataObjectTypeItem ?? []
  const uuids = (data.mergeableDataObjectUuidItem ?? []).map(uuidToHex)

  const root = objects.find(
    (object) =>
      object.customMap?.type != null && types[object.customMap.type] === AN_TABLE_TYPE.ICTable
  )
  if (!root) return null

  let rows = { positions: new Map<string, number>(), count: 0 }
  let columns = { positions: new Map<string, number>(), count: 0 }
  let cells: ANMergeableObject | undefined

  for (const entry of root.customMap?.mapEntry ?? []) {
    const target = entry.value?.objectIndex != null ? objects[entry.value.objectIndex] : undefined
    if (!target) continue
    switch (keys[entry.key ?? -1]) {
      case AN_TABLE_KEY.Rows:
        rows = orderedPositions(target.orderedSet, objects, keys, uuids)
        break
      case AN_TABLE_KEY.Columns:
        columns = orderedPositions(target.orderedSet, objects, keys, uuids)
        break
      case AN_TABLE_KEY.CellColumns:
        cells = target
        break
    }
  }

  if (!cells || rows.count === 0 || columns.count === 0) return null

  const grid: string[][] = Array.from({ length: rows.count }, () =>
    Array.from({ length: columns.count }, () => '')
  )

  for (const column of cells.dictionary?.element ?? []) {
    const columnIndex = columns.positions.get(targetUuid(column.key, objects, keys, uuids))
    if (columnIndex == null) continue
    const columnCells = column.value?.objectIndex != null ? objects[column.value.objectIndex] : null
    for (const cell of columnCells?.dictionary?.element ?? []) {
      const rowIndex = rows.positions.get(targetUuid(cell.key, objects, keys, uuids))
      if (rowIndex == null) continue
      const content = cell.value?.objectIndex != null ? objects[cell.value.objectIndex] : null
      const note = content?.note
      if (!note) continue
      grid[rowIndex][columnIndex] = noteToCellMarkdown({
        text: note.noteText ?? '',
        runs: note.attributeRun ?? []
      })
    }
  }

  return { rows: grid }
}

/**
 * Render a decoded table as a GFM pipe table.
 *
 * Apple Notes tables carry no header flag, but a markdown table must have a
 * header row, so the first row becomes the header — which is what people who
 * label their first row expect, and harmless formatting for those who don't.
 * Returns '' for an empty table so the caller can drop the placeholder.
 */
export function tableToMarkdown(table: DecodedTable): string {
  const [header, ...body] = table.rows
  if (!header || header.length === 0) return ''

  const line = (cells: string[]): string =>
    `| ${Array.from({ length: header.length }, (_, i) => cells[i] ?? '').join(' | ')} |`

  return [
    line(header),
    `| ${Array.from({ length: header.length }, () => '---').join(' | ')} |`,
    ...body.map(line)
  ].join('\n')
}
