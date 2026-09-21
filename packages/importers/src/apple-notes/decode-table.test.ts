import { describe, it, expect } from 'vitest'
import { Root } from 'protobufjs'
import { descriptor, MERGEABLE_DATA_TYPE } from './descriptor.ts'
import { decodeTable, tableToMarkdown } from './decode-table.ts'
import { noteToCellMarkdown } from './convert-doc.ts'
import { ANFontWeight } from './types.ts'

/**
 * Encode a synthetic table payload in the exact shape Apple Notes writes to
 * ICAttachment.ZMERGEABLEDATA1, so the decode path is exercised end-to-end
 * without a real NoteStore.sqlite:
 *
 *  - keys/types/uuids are lookup lists; every reference is an index into one
 *  - each row/column uuid is wrapped in its own NSUUID object (two hops from a
 *    reference to the uuid itself)
 *  - `ordering.array` fixes display order; `ordering.contents` maps the ordered
 *    uuid to the uuid the cell dictionaries are keyed by
 *  - cells are `dictionary`: column uuid -> (dictionary: row uuid -> note)
 *
 * `cells` is row-major; a `null` cell is left out of the payload entirely,
 * which is how Apple stores an untouched cell.
 */
export function encodeTablePayload(cells: (string | null)[][]): Uint8Array {
  const keys = ['identity', 'crRows', 'crColumns', 'cellColumns', 'UUIDIndex']
  const types = ['com.apple.CRDT.NSUUID', 'com.apple.notes.ICTable']
  const KEY = { rows: 1, columns: 2, cellColumns: 3, uuidIndex: 4 }
  const TYPE = { uuid: 0, table: 1 }

  const rowCount = cells.length
  const columnCount = Math.max(...cells.map((row) => row.length))

  // uuid list: one per row, then one per column.
  const uuids: number[][] = []
  for (let i = 0; i < rowCount + columnCount; i++) {
    uuids.push([i + 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const objects: any[] = []
  const push = (object: any): number => objects.push(object) - 1

  // Index 0 is the root; its references are filled in once the rest exists.
  const rootIndex = push({ customMap: { type: TYPE.table, mapEntry: [] } })

  /** An NSUUID wrapper: the only way a reference names a row/column uuid. */
  const uuidObject = (uuidIndex: number): number =>
    push({
      customMap: {
        type: TYPE.uuid,
        mapEntry: [{ key: KEY.uuidIndex, value: { unsignedIntegerValue: uuidIndex } }]
      }
    })

  /** The ordered set that fixes row (or column) order. */
  const orderedSet = (uuidIndices: number[]): number => {
    const attachment = uuidIndices.map((uuidIndex, position) => ({
      index: position,
      uuid: new Uint8Array(uuids[uuidIndex])
    }))
    const element = uuidIndices.map((uuidIndex) => ({
      key: { objectIndex: uuidObject(uuidIndex) },
      value: { objectIndex: uuidObject(uuidIndex) }
    }))
    return push({ orderedSet: { ordering: { array: { attachment }, contents: { element } } } })
  }

  const rowUuids = Array.from({ length: rowCount }, (_, i) => i)
  const columnUuids = Array.from({ length: columnCount }, (_, i) => rowCount + i)
  const rowsIndex = orderedSet(rowUuids)
  const columnsIndex = orderedSet(columnUuids)

  const columnElements: any[] = []
  for (let column = 0; column < columnCount; column++) {
    const rowElements: any[] = []
    for (let row = 0; row < rowCount; row++) {
      const cell = cells[row][column]
      if (cell == null) continue
      rowElements.push({
        key: { objectIndex: uuidObject(rowUuids[row]) },
        value: {
          objectIndex: push({
            note: { noteText: cell, attributeRun: [{ length: cell.length }] }
          })
        }
      })
    }
    columnElements.push({
      key: { objectIndex: uuidObject(columnUuids[column]) },
      value: { objectIndex: push({ dictionary: { element: rowElements } }) }
    })
  }
  const cellsIndex = push({ dictionary: { element: columnElements } })

  objects[rootIndex].customMap.mapEntry = [
    { key: 0, value: { stringValue: '00000000-0000-0000-0000-000000000000' } },
    { key: KEY.rows, value: { objectIndex: rowsIndex } },
    { key: KEY.columns, value: { objectIndex: columnsIndex } },
    { key: KEY.cellColumns, value: { objectIndex: cellsIndex } }
  ]
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const Proto = Root.fromJSON(descriptor).lookupType(MERGEABLE_DATA_TYPE)
  const payload = {
    mergableDataObject: {
      version: 1,
      mergeableDataObjectData: {
        mergeableDataObjectEntry: objects,
        mergeableDataObjectKeyItem: keys,
        mergeableDataObjectTypeItem: types,
        mergeableDataObjectUuidItem: uuids.map((uuid) => new Uint8Array(uuid))
      }
    }
  }
  const err = Proto.verify(payload)
  if (err) throw new Error(err)
  return Proto.encode(Proto.fromObject(payload)).finish()
}

describe('decodeTable', () => {
  it('rebuilds a grid in row/column order', () => {
    const bytes = encodeTablePayload([
      ['Day', 'Exercise'],
      ['Mon', 'Squat'],
      ['Tue', 'Bench']
    ])
    expect(decodeTable(bytes)?.rows).toEqual([
      ['Day', 'Exercise'],
      ['Mon', 'Squat'],
      ['Tue', 'Bench']
    ])
  })

  it('renders the grid as a GFM table with the first row as the header', () => {
    const bytes = encodeTablePayload([
      ['Day', 'Exercise'],
      ['Mon', 'Squat']
    ])
    const table = decodeTable(bytes)
    expect(table).not.toBeNull()
    expect(tableToMarkdown(table!)).toBe(
      ['| Day | Exercise |', '| --- | --- |', '| Mon | Squat |'].join('\n')
    )
  })

  it('pads untouched cells so every row keeps the table width', () => {
    const bytes = encodeTablePayload([
      ['a', 'b'],
      ['c', null]
    ])
    const table = decodeTable(bytes)
    expect(table?.rows).toEqual([
      ['a', 'b'],
      ['c', '']
    ])
    expect(tableToMarkdown(table!)).toContain('| c |  |')
  })

  it('keeps a pipe inside a cell from splitting the row', () => {
    const bytes = encodeTablePayload([
      ['a | b', 'c'],
      ['d', 'e']
    ])
    const markdown = tableToMarkdown(decodeTable(bytes)!)
    expect(markdown).toContain('| a \\| b | c |')
    // Header, delimiter and one body row — the escaped pipe added no column.
    expect(markdown.split('\n').every((line) => line.split(' | ').length === 2)).toBe(true)
  })

  it('escapes a backslash so it cannot escape the pipe escape', () => {
    // A cell holding `a \| b` must not become `a \\| b`, which markdown reads
    // as an escaped backslash followed by a live pipe -> an extra column.
    const bytes = encodeTablePayload([
      ['a \\| b', 'c'],
      ['d', 'e']
    ])
    const markdown = tableToMarkdown(decodeTable(bytes)!)
    expect(markdown).toContain('| a \\\\\\| b | c |')
    expect(markdown.split('\n').every((line) => line.split(' | ').length === 2)).toBe(true)
  })

  it('returns null for a payload that carries no table', () => {
    const Proto = Root.fromJSON(descriptor).lookupType(MERGEABLE_DATA_TYPE)
    const bytes = Proto.encode(
      Proto.fromObject({
        mergableDataObject: {
          version: 1,
          mergeableDataObjectData: { mergeableDataObjectTypeItem: ['com.apple.CRDT.NSString'] }
        }
      })
    ).finish()
    expect(decodeTable(bytes)).toBeNull()
  })

  it('renders nothing for an empty table', () => {
    expect(tableToMarkdown({ rows: [] })).toBe('')
    expect(tableToMarkdown({ rows: [[]] })).toBe('')
  })
})

describe('noteToCellMarkdown', () => {
  it('keeps inline formatting and links', () => {
    const text = 'bold link'
    expect(
      noteToCellMarkdown({
        text,
        runs: [
          { length: 4, fontWeight: ANFontWeight.Bold },
          { length: 1 },
          { length: 4, link: 'https://example.com' }
        ]
      })
    ).toBe('**bold** [link](https://example.com)')
  })

  it('flattens the cell onto one line', () => {
    // `<br>` does not survive Memry's markdown round-trip and a raw newline
    // would end the table row, so the break becomes a space.
    expect(noteToCellMarkdown({ text: 'one\ntwo\u2028three', runs: [{ length: 13 }] })).toBe(
      'one two three'
    )
  })
})
