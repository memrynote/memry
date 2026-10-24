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

export interface TableSize {
  rows: number
  columns: number
}

export interface NewTableContent {
  type: 'tableContent'
  headerRows: 1
  rows: { cells: string[] }[]
}

/**
 * The content of a freshly inserted `rows` x `columns` table, header row
 * included in `rows`.
 *
 * A note body is stored as markdown, and a GFM table cannot exist without a
 * header separator: a table saved with `headerRows: 0` comes back from the file
 * carrying an empty header row that nobody typed, which is the "my table only
 * grows a header once I leave the page and come back" report. So the first row
 * is the header the storage format is going to add anyway.
 */
export function buildTableContent({ rows, columns }: TableSize): NewTableContent {
  return {
    type: 'tableContent',
    headerRows: 1,
    rows: Array.from({ length: rows }, () => ({
      cells: Array.from({ length: columns }, () => '')
    }))
  }
}
