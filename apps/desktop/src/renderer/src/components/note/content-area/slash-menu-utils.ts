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
