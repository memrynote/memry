import { describe, it, expect } from 'vitest'
import {
  locateTag,
  resolveDropTarget,
  previewTagMove,
  previewContainerMove,
  beginTagDrag,
  commitTagMove,
  resolveTagDrop
} from './drag-session'
import { moveTag } from './reorder'
import type { HubState } from './reorder'

const tag = (t: string, sortOrder: number) => ({
  tag: t,
  color: 'blue',
  icon: null,
  count: 1,
  sortOrder
})

const snapshot: HubState = {
  categories: [
    { id: 'work', name: 'Work', sortOrder: 0, tags: [tag('meetings', 0), tag('okr', 1)] },
    { id: 'books', name: 'Books', sortOrder: 1, tags: [tag('general', 0)] }
  ],
  uncategorized: [tag('idea', 0)]
}

describe('locateTag', () => {
  it('finds a tag inside a category', () => {
    expect(locateTag(snapshot, 'okr')).toEqual({ categoryId: 'work', index: 1 })
  })

  it('finds a tag in the uncategorized bucket', () => {
    expect(locateTag(snapshot, 'idea')).toEqual({ categoryId: null, index: 0 })
  })

  it('returns null for an unknown tag', () => {
    expect(locateTag(snapshot, 'nope')).toBeNull()
  })
})

describe('resolveDropTarget', () => {
  it('drops at the hovered chip index within that chip’s category', () => {
    const target = resolveDropTarget(snapshot, {
      type: 'tag',
      tag: 'okr',
      categoryId: 'work'
    })
    expect(target).toEqual({ categoryId: 'work', index: 1 })
  })

  it('appends to the end when hovering a category’s empty space', () => {
    const target = resolveDropTarget(snapshot, { type: 'tag-container', categoryId: 'work' })
    expect(target).toEqual({ categoryId: 'work', index: 2 })
  })

  it('resolves the uncategorized container', () => {
    const target = resolveDropTarget(snapshot, { type: 'tag-container', categoryId: null })
    expect(target).toEqual({ categoryId: null, index: 1 })
  })
})

describe('previewTagMove', () => {
  it('relocates the tag into the target bucket for rendering', () => {
    const preview = previewTagMove(snapshot, 'idea', { categoryId: 'work', index: 0 })

    expect(preview).not.toBeNull()
    const work = preview!.categories.find((c) => c.id === 'work')!
    expect(work.tags.map((t) => t.tag)).toEqual(['idea', 'meetings', 'okr'])
    expect(preview!.uncategorized).toEqual([])
  })

  it('preserves the moved tag’s colour, icon and count', () => {
    const preview = previewTagMove(snapshot, 'idea', { categoryId: 'work', index: 0 })
    const moved = preview!.categories.find((c) => c.id === 'work')!.tags[0]
    expect(moved).toMatchObject({ tag: 'idea', color: 'blue', icon: null, count: 1 })
  })

  it('returns null when the tag already sits at the target (no re-render thrash)', () => {
    expect(previewTagMove(snapshot, 'okr', { categoryId: 'work', index: 1 })).toBeNull()
  })
})

describe('commitTagMove', () => {
  // The seam this whole module exists to protect. During a drag the preview
  // has ALREADY moved the tag, so running the ordering arithmetic against it
  // asks "move idea to where idea already is" — `moveTag` correctly answers
  // "nothing changed" and returns []. The drag would look right on screen and
  // persist nothing. The arithmetic must run against the pre-drag snapshot.
  it('computes assignments from the snapshot, not the already-moved preview', () => {
    const session = beginTagDrag(snapshot, 'idea')
    const firstHover = previewTagMove(snapshot, 'idea', { categoryId: 'work', index: 0 })!
    const secondHover = previewTagMove(firstHover, 'idea', { categoryId: 'books', index: 0 })!

    const assignments = commitTagMove(session, secondHover)

    expect(assignments).not.toEqual([])
    expect(assignments).toEqual(moveTag(snapshot, 'idea', 'books', 0))
    expect(assignments).toContainEqual({ tag: 'idea', categoryId: 'books', sortOrder: 0 })
    expect(assignments).toContainEqual({ tag: 'general', categoryId: 'books', sortOrder: 1 })
  })

  it('does not double-apply when the preview crossed several categories', () => {
    const session = beginTagDrag(snapshot, 'idea')
    const firstHover = previewTagMove(snapshot, 'idea', { categoryId: 'work', index: 0 })!
    const secondHover = previewTagMove(firstHover, 'idea', { categoryId: 'books', index: 0 })!

    const assignments = commitTagMove(session, secondHover)

    // `work` is untouched by the final arrangement, so no row of it may be
    // renumbered — a preview-derived computation would drag its intermediate
    // state into the persisted result.
    expect(assignments.filter((a) => a.categoryId === 'work')).toEqual([])
    expect(assignments.filter((a) => a.tag === 'idea')).toHaveLength(1)
  })

  it('keeps the snapshot even after the preview has moved on', () => {
    const session = beginTagDrag(snapshot, 'idea')
    previewTagMove(snapshot, 'idea', { categoryId: 'work', index: 0 })
    expect(session.snapshot).toBe(snapshot)
  })

  it('returns an empty list when the drag ended where it started', () => {
    expect(commitTagMove(beginTagDrag(snapshot, 'idea'), snapshot)).toEqual([])
  })

  it('returns an empty list when the tag is missing from the preview', () => {
    expect(commitTagMove(beginTagDrag(snapshot, 'nope'), snapshot)).toEqual([])
  })
})

describe('previewContainerMove', () => {
  const overGeneral = { type: 'tag', tag: 'general', categoryId: 'books' } as const
  const booksOrder = (state: HubState): string[] =>
    state.categories.find((c) => c.id === 'books')!.tags.map((t) => t.tag)

  // Documents the failure this guard exists to stop. Previewing *within* a
  // container feeds itself: the moved chip shifts the index the hovered chip
  // reports, which moves the chip again, which shifts the index back. On the
  // page each step is a setState, so React aborts the render with "Maximum
  // update depth exceeded" — even with a stationary pointer.
  it('previewing within a container oscillates between two orders', () => {
    const a = previewTagMove(snapshot, 'idea', resolveDropTarget(snapshot, overGeneral))!
    const b = previewTagMove(a, 'idea', resolveDropTarget(a, overGeneral))!
    const c = previewTagMove(b, 'idea', resolveDropTarget(b, overGeneral))!

    expect(booksOrder(a)).toEqual(['idea', 'general'])
    expect(booksOrder(b)).toEqual(['general', 'idea'])
    expect(booksOrder(c)).toEqual(booksOrder(a))
  })

  it('moves the tag when the hovered category differs from its own', () => {
    const next = previewContainerMove(snapshot, 'idea', overGeneral)
    expect(next).not.toBeNull()
    expect(booksOrder(next!)).toEqual(['idea', 'general'])
    expect(next!.uncategorized).toEqual([])
  })

  it('goes quiet once the tag is already in the hovered category', () => {
    const first = previewContainerMove(snapshot, 'idea', overGeneral)!
    expect(previewContainerMove(first, 'idea', overGeneral)).toBeNull()
  })

  it('settles instead of oscillating when applied repeatedly', () => {
    let state: HubState = snapshot
    for (let i = 0; i < 5; i++) {
      const next = previewContainerMove(state, 'idea', overGeneral)
      if (!next) break
      state = next
    }
    expect(previewContainerMove(state, 'idea', overGeneral)).toBeNull()
    expect(booksOrder(state)).toEqual(['idea', 'general'])
  })

  it('is quiet for a container drop onto the category the tag already sits in', () => {
    expect(
      previewContainerMove(snapshot, 'okr', { type: 'tag-container', categoryId: 'work' })
    ).toBeNull()
  })
})

describe('commitTagMove with a final collision', () => {
  // Within a container the preview deliberately stops tracking position, so
  // the drop's own `over` supplies the final index — resolved against the
  // preview (which knows the chip is already there), applied to the snapshot.
  it('takes the final index from the hovered chip in the preview', () => {
    const session = beginTagDrag(snapshot, 'idea')
    const preview = previewContainerMove(snapshot, 'idea', {
      type: 'tag',
      tag: 'general',
      categoryId: 'books'
    })!

    const assignments = commitTagMove(session, preview, {
      type: 'tag',
      tag: 'general',
      categoryId: 'books'
    })

    // `general` sits at index 1 of the preview, so that is where `idea` lands.
    expect(assignments).toEqual(moveTag(snapshot, 'idea', 'books', 1))
    expect(assignments).toContainEqual({ tag: 'idea', categoryId: 'books', sortOrder: 1 })
  })

  it('falls back to the preview position when no collision is supplied', () => {
    const session = beginTagDrag(snapshot, 'idea')
    const preview = previewContainerMove(snapshot, 'idea', {
      type: 'tag',
      tag: 'general',
      categoryId: 'books'
    })!

    expect(commitTagMove(session, preview)).toEqual(moveTag(snapshot, 'idea', 'books', 0))
  })
})

describe('resolveTagDrop', () => {
  // The preview is a rendering aid, not the only route to a committed move: a
  // drag can end before a single `onDragOver` fires (a fast release, or a
  // keyboard drop that never crosses a droppable). Losing the write in that
  // case would look exactly like the drag silently doing nothing.
  it('computes assignments straight from the final collision', () => {
    const assignments = resolveTagDrop(snapshot, 'idea', {
      type: 'tag',
      tag: 'general',
      categoryId: 'books'
    })
    expect(assignments).toEqual(moveTag(snapshot, 'idea', 'books', 0))
  })

  it('appends when the drop landed on a category container rather than a chip', () => {
    const assignments = resolveTagDrop(snapshot, 'idea', {
      type: 'tag-container',
      categoryId: 'work'
    })
    expect(assignments).toContainEqual({ tag: 'idea', categoryId: 'work', sortOrder: 2 })
  })

  it('returns an empty list when the drop changed nothing', () => {
    expect(
      resolveTagDrop(snapshot, 'okr', { type: 'tag', tag: 'okr', categoryId: 'work' })
    ).toEqual([])
  })
})
