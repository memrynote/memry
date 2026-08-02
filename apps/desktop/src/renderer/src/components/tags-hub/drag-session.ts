/**
 * Drag-session arithmetic for the tag hub's drag-and-drop.
 *
 * No React, no dnd-kit — the page wires pointer events to these functions and
 * renders whatever they return. Keeping them pure is what makes the seam
 * below testable without simulating a pointer drag in jsdom.
 *
 * A tag drag runs against TWO states at once, and conflating them is the
 * subtle failure this module exists to prevent:
 *
 * - the **preview**, which has already moved the tag so the user can see it
 *   land, and is what gets rendered mid-drag;
 * - the **snapshot** taken at drag start, which still holds the pre-drag
 *   truth and is the only correct input to the ordering arithmetic.
 *
 * Compute the final assignments from the preview and `moveTag` is asked to
 * "move the tag to where it already is" — it correctly answers "nothing
 * changed" and returns an empty list. The drag looks right on screen and
 * persists nothing. `commitTagMove` takes both states precisely so that
 * mistake cannot be made at the call site.
 */
import { moveTag, applyTagAssignments, type HubState } from './reorder'
import type { HubTag } from '@/hooks/use-tag-categories'
import type { TagAssignment } from '@/services/tags-service'

/** Where a tag sits (or should sit): which bucket, and at which index. */
export interface TagPosition {
  categoryId: string | null
  index: number
}

/**
 * What the pointer is currently over, as reported by dnd-kit's droppable
 * data: either another chip (insert at that chip's index) or a category's
 * tag container — an empty category, or the blank space past the last chip
 * (append to the end).
 */
export type OverTarget =
  | { type: 'tag'; tag: string; categoryId: string | null }
  | { type: 'tag-container'; categoryId: string | null }

function bucketOf(state: HubState, categoryId: string | null): HubTag[] {
  if (categoryId === null) return state.uncategorized
  return state.categories.find((c) => c.id === categoryId)?.tags ?? []
}

/** Finds `tag`'s current bucket and index, or null if it isn't in `state`. */
export function locateTag(state: HubState, tag: string): TagPosition | null {
  const uncategorizedIndex = state.uncategorized.findIndex((t) => t.tag === tag)
  if (uncategorizedIndex !== -1) return { categoryId: null, index: uncategorizedIndex }

  for (const category of state.categories) {
    const index = category.tags.findIndex((t) => t.tag === tag)
    if (index !== -1) return { categoryId: category.id, index }
  }
  return null
}

/** Translates a hovered droppable into the position the tag would take. */
export function resolveDropTarget(state: HubState, over: OverTarget): TagPosition {
  const bucket = bucketOf(state, over.categoryId)
  if (over.type === 'tag-container') {
    return { categoryId: over.categoryId, index: bucket.length }
  }
  const index = bucket.findIndex((t) => t.tag === over.tag)
  return { categoryId: over.categoryId, index: index === -1 ? bucket.length : index }
}

/**
 * The arrangement to render while the pointer hovers `target`: `current` with
 * `tag` relocated. Returns null when the tag already sits there, so the page
 * can skip a state update instead of re-rendering on every pointer move.
 */
export function previewTagMove(
  current: HubState,
  tag: string,
  target: TagPosition
): HubState | null {
  const assignments = moveTag(current, tag, target.categoryId, target.index)
  if (assignments.length === 0) return null
  return applyTagAssignments(current.categories, current.uncategorized, assignments)
}

/**
 * The preview update to apply while dragging — or null to leave the render
 * alone.
 *
 * Only a change of *category* is written to state. Position within a
 * category is deliberately left to `SortableContext`'s own displacement,
 * which shuffles chips visually without touching React state.
 *
 * Previewing within a container feeds itself and never converges: moving the
 * chip changes the index the hovered chip reports, which moves the chip
 * again, which changes the index back. With `books: [general]` and the
 * pointer held still over `general`, previewing `idea` in yields
 * `[idea, general]` → `[general, idea]` → `[idea, general]` … Each step is a
 * `setState` on the page, so React gives up with "Maximum update depth
 * exceeded". This is also what dnd-kit's own multiple-container recipe does,
 * and for the same reason.
 */
export function previewContainerMove(
  current: HubState,
  tag: string,
  over: OverTarget
): HubState | null {
  const from = locateTag(current, tag)
  if (!from || from.categoryId === over.categoryId) return null
  return previewTagMove(current, tag, resolveDropTarget(current, over))
}

/**
 * A drag in flight: the tag being moved plus the pre-drag ordering it must
 * be measured against. Opened once at drag start and handed back to
 * `commitTagMove`, so the snapshot can't be confused with the live preview
 * at the call site — the two are structurally identical `HubState`s, and
 * passing the wrong one is the failure this module is built to rule out.
 */
export interface TagDragSession {
  readonly tag: string
  readonly snapshot: HubState
}

/** Captures the pre-drag ordering. Call once, from `onDragStart`. */
export function beginTagDrag(snapshot: HubState, tag: string): TagDragSession {
  return { tag, snapshot }
}

/**
 * The assignments to persist once the drag ends, computed against the
 * session's pre-drag ordering. See the module comment for why the snapshot —
 * not the preview — is the input.
 *
 * `over` is the drop's final collision. It matters because `previewContainerMove`
 * stops tracking position once the tag is inside the hovered category, so the
 * preview alone only knows *which* category the chip landed in; the hovered
 * chip's index within the preview is what says where in it. Resolving against
 * the preview (not the snapshot) is deliberate: the preview is the arrangement
 * the user is actually looking at when they release. Without `over`, the tag's
 * own preview position is used.
 */
export function commitTagMove(
  session: TagDragSession,
  preview: HubState,
  over?: OverTarget
): TagAssignment[] {
  const landed = over ? resolveDropTarget(preview, over) : locateTag(preview, session.tag)
  if (!landed) return []
  return moveTag(session.snapshot, session.tag, landed.categoryId, landed.index)
}

/**
 * The assignments for a drop resolved straight from the final collision,
 * with no preview in hand.
 *
 * `commitTagMove` is the better path when a preview exists, because dragging
 * a chip above versus below its neighbour produces the same `over` chip and
 * only the accumulated preview records which side the pointer settled on.
 * But a drag can end without a single `onDragOver` — a fast press-move-release,
 * or a keyboard drop that never crosses another droppable — and the move
 * still has to persist. Without this fallback such a drop writes nothing,
 * which on screen is indistinguishable from drag-and-drop being broken.
 */
export function resolveTagDrop(state: HubState, tag: string, over: OverTarget): TagAssignment[] {
  const target = resolveDropTarget(state, over)
  return moveTag(state, tag, target.categoryId, target.index)
}
