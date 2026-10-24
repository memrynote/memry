/**
 * Inbox item metadata is typed as the union of every item kind's shape, and the item's own type
 * decides which member it is. The union has no discriminant of its own, so each preview names the
 * shape its item kind stores.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the metadata shape its item kind stores; nothing in the argument can carry it
export function metadataAs<T>(metadata: unknown): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the item type selects the stored metadata shape; the union has no discriminant to narrow on
  return metadata as T
}
