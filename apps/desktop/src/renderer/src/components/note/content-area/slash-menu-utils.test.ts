import { describe, expect, it } from 'vitest'

import { orderSlashMenuItemsByGroup, withTableHeaderRow } from './slash-menu-utils'

const groups = <T extends { group?: string }>(items: T[]) => items.map((i) => i.group)

describe('orderSlashMenuItemsByGroup', () => {
  it('collapses non-contiguous duplicate groups into one contiguous run', () => {
    // The real bug: default "Basic blocks" items appear at the front, while the
    // appended Callout/Task items (also "Basic blocks") land at the back, so the
    // group renders twice with the same React key and leaves ghost headers.
    const items = [
      { title: 'Paragraph', group: 'Basic blocks' },
      { title: 'Image', group: 'Media' },
      { title: 'Callout', group: 'Basic blocks' },
      { title: 'Task', group: 'Basic blocks' }
    ]

    const ordered = orderSlashMenuItemsByGroup(items)

    // "Basic blocks" must appear exactly once in the group sequence.
    expect(groups(ordered)).toEqual(['Basic blocks', 'Basic blocks', 'Basic blocks', 'Media'])
    expect(groups(ordered).filter((g) => g === 'Basic blocks')).toHaveLength(3)
    expect(new Set(groups(ordered)).size).toBe(2)
  })

  it('preserves first-seen group order and within-group order', () => {
    const items = [
      { title: 'a', group: 'B' },
      { title: 'b', group: 'A' },
      { title: 'c', group: 'B' },
      { title: 'd', group: 'A' }
    ]

    const ordered = orderSlashMenuItemsByGroup(items)

    expect(ordered.map((i) => i.title)).toEqual(['a', 'c', 'b', 'd'])
    expect(groups(ordered)).toEqual(['B', 'B', 'A', 'A'])
  })

  it('handles items without a group without throwing', () => {
    const items = [{ title: 'x' }, { title: 'y', group: 'G' }, { title: 'z' }]

    const ordered = orderSlashMenuItemsByGroup(items)

    expect(ordered.map((i) => i.title)).toEqual(['x', 'z', 'y'])
    expect(groups(ordered)).toEqual([undefined, undefined, 'G'])
  })

  it('returns an empty array unchanged', () => {
    expect(orderSlashMenuItemsByGroup([])).toEqual([])
  })
})

describe('withTableHeaderRow', () => {
  // BlockNote's default `/table` inserts a header-less 2x3 table, and the
  // cursor lands inside it, so the editor reports the table as the cursor block.
  function editorWithInsertedTable(headerRows?: number, rowCount = 2) {
    const row = () => ({ cells: [{ text: '' }, { text: '' }, { text: '' }] })
    const block = {
      id: 'tbl',
      type: 'table',
      content: {
        type: 'tableContent' as const,
        columnWidths: [null, null, null],
        ...(headerRows === undefined ? {} : { headerRows }),
        rows: Array.from({ length: rowCount }, row)
      }
    }
    const updates: unknown[] = []
    return {
      block,
      updates,
      editor: {
        getTextCursorPosition: () => ({ block }),
        updateBlock: (_target: unknown, update: unknown) => updates.push(update)
      }
    }
  }

  const tableItem = (onItemClick: () => void) => [
    { key: 'paragraph', onItemClick: () => {} },
    { key: 'table', onItemClick }
  ]

  it('gives a freshly inserted table a header row plus the two body rows', () => {
    const { editor, updates } = editorWithInsertedTable()
    let inserted = false
    const items = withTableHeaderRow(
      tableItem(() => {
        inserted = true
      }),
      editor
    )

    items.find((i) => i.key === 'table')!.onItemClick!()

    expect(inserted).toBe(true)
    expect(updates).toHaveLength(1)
    const content = (updates[0] as { content: { headerRows: number; rows: unknown[] } }).content
    expect(content.headerRows).toBe(1)
    // One header row on top of the two body rows BlockNote hands out, so the
    // table markdown writes and the table markdown reads back are the same one.
    expect(content.rows).toHaveLength(3)
  })

  it('leaves every other item untouched', () => {
    const { editor } = editorWithInsertedTable()
    const original = tableItem(() => {})
    const items = withTableHeaderRow(original, editor)

    expect(items.find((i) => i.key === 'paragraph')).toBe(original[0])
  })

  it('does not re-promote a table that already has a header row', () => {
    const { editor, updates } = editorWithInsertedTable(1)
    const items = withTableHeaderRow(
      tableItem(() => {}),
      editor
    )

    items.find((i) => i.key === 'table')!.onItemClick!()

    expect(updates).toEqual([])
  })

  it('does nothing when the insert did not leave the cursor in a table', () => {
    const updates: unknown[] = []
    const editor = {
      getTextCursorPosition: () => ({ block: { type: 'paragraph', content: [] } }),
      updateBlock: (_t: unknown, u: unknown) => updates.push(u)
    }
    const items = withTableHeaderRow(
      tableItem(() => {}),
      editor
    )

    items.find((i) => i.key === 'table')!.onItemClick!()

    expect(updates).toEqual([])
  })
})
