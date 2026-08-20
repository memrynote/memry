// Stable-group slash-menu items so every item sharing a `group` is contiguous,
// preserving first-seen group order and within-group order. BlockNote's
// SuggestionMenu emits one group label per contiguous run, keyed by the group
// string, so non-contiguous duplicate groups produce duplicate React keys and
// leave ghost headers behind as the query filter changes.
export function orderSlashMenuItemsByGroup<T extends { group?: string }>(items: T[]): T[] {
  const order: (string | undefined)[] = []
  const byGroup = new Map<string | undefined, T[]>()

  for (const item of items) {
    let bucket = byGroup.get(item.group)
    if (!bucket) {
      bucket = []
      byGroup.set(item.group, bucket)
      order.push(item.group)
    }
    bucket.push(item)
  }

  return order.flatMap((group) => byGroup.get(group)!)
}

type TableRow = { cells: unknown[] }

type TableContent = {
  type: 'tableContent'
  headerRows?: number
  rows: TableRow[]
}

export type TableInsertEditor = {
  getTextCursorPosition: () => { block?: { type?: string; content?: unknown } } | undefined
  updateBlock: (block: unknown, update: { type: 'table'; content: TableContent }) => void
}

function isTableContent(content: unknown): content is TableContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    (content as TableContent).type === 'tableContent' &&
    Array.isArray((content as TableContent).rows)
  )
}

// A note body is stored as markdown, and a GFM table cannot exist without a
// header separator: a table saved with `headerRows: 0` comes back from the file
// carrying an empty header row that nobody typed, which is the "my table only
// grows a header once I leave the page and come back" report. BlockNote's own
// `/table` item inserts a header-less table regardless of `tables.headers`, so
// insert the header row the storage format is going to add anyway — and keep
// the two body rows the default hands out by appending one.
export function withTableHeaderRow<T extends { key?: string; onItemClick?: () => void }>(
  items: T[],
  editor: TableInsertEditor
): T[] {
  return items.map((item) =>
    item.key === 'table'
      ? {
          ...item,
          onItemClick: () => {
            item.onItemClick?.()
            const block = editor.getTextCursorPosition()?.block
            if (block?.type !== 'table' || !isTableContent(block.content)) return
            const content = block.content
            if (content.headerRows) return
            const lastRow = content.rows[content.rows.length - 1]
            editor.updateBlock(block, {
              type: 'table',
              content: {
                ...content,
                headerRows: 1,
                rows: lastRow ? [...content.rows, structuredClone(lastRow)] : content.rows
              }
            })
          }
        }
      : item
  )
}
