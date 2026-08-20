/**
 * Resolve the sidebar's section order from what the user last dragged.
 *
 * The saved order is a plain list of ids in `sidebar.sectionOrder`, so it
 * can be written by an older build (missing a section that exists today) or a
 * newer one (carrying a section this build has never heard of), and a section
 * can disappear mid-run when its feature flag goes off.
 *
 * Both directions have to stay safe:
 * - ids the caller does not render are dropped (unknown, or flag-disabled),
 * - sections absent from the saved order are re-inserted right after the
 *   default sibling that precedes them, so a newly added section lands in its
 *   default slot instead of being appended to the bottom or vanishing.
 */
export function resolveSidebarSectionOrder(
  defaultIds: readonly string[],
  savedOrder: readonly string[] | undefined
): string[] {
  const known = new Set(defaultIds)
  const placed = new Set<string>()
  const result: string[] = []

  for (const id of savedOrder ?? []) {
    if (!known.has(id) || placed.has(id)) continue
    result.push(id)
    placed.add(id)
  }

  for (let i = 0; i < defaultIds.length; i++) {
    const id = defaultIds[i]
    if (placed.has(id)) continue

    // Anchor to the nearest preceding default sibling that is already on screen;
    // with none (this is the first default section) it goes to the top.
    let insertAt = 0
    for (let j = i - 1; j >= 0; j--) {
      const anchor = result.indexOf(defaultIds[j])
      if (anchor !== -1) {
        insertAt = anchor + 1
        break
      }
    }

    result.splice(insertAt, 0, id)
    placed.add(id)
  }

  return result
}

/**
 * Apply a section drop to the current order.
 *
 * Returns `null` when the drop changes nothing: the section landed on itself, or
 * on something that is not a section at all (the app-level DndContext is shared
 * with tasks, projects and the folder tree, so `over` can be any of those).
 */
export function reorderSidebarSections(
  ids: readonly string[],
  activeId: string,
  overId: string
): string[] | null {
  if (activeId === overId) return null

  const from = ids.indexOf(activeId)
  const to = ids.indexOf(overId)
  if (from === -1 || to === -1) return null

  const next = [...ids]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}
