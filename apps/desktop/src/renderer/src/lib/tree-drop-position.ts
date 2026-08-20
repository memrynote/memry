/**
 * The single drop contract for both sidebar trees.
 *
 * The sidebar swaps between two implementations of the same tree — the
 * kibo `TreeNode` one and `VirtualizedNotesTree`, once the vault passes the
 * virtualization threshold — so the geometry that decides before/after/inside
 * has to live in one place. It did not: the virtualized copy resolved the
 * middle band from `hasChildren`, so a freshly created (empty) folder never
 * offered "inside" and could not take a dropped folder until it already had
 * one child.
 */

export type DropPosition = 'before' | 'after' | 'inside'

/**
 * Resolve where a drag hovering over a row should land.
 *
 * `canDropInside` is a property of the row itself (a folder accepts children,
 * a note does not) — never of whether the row currently has any.
 *
 * @param offsetY pointer position relative to the row's top edge
 * @param height the row's height
 */
export function resolveDropPosition(
  offsetY: number,
  height: number,
  canDropInside: boolean
): DropPosition {
  // A row that takes children keeps a narrow reorder band at each edge so the
  // bulk of it drops inside; one that cannot just splits in half.
  const threshold = canDropInside ? height / 4 : height / 2

  if (offsetY < threshold) return 'before'
  if (offsetY > height - threshold) return 'after'
  return canDropInside ? 'inside' : 'after'
}
