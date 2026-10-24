import { describe, expect, it } from 'vitest'

import {
  FRAME_BINDING_KEY,
  LAYOUT_EMPTY_FRAME,
  LAYOUT_FRAME_PADDING,
  UNCHANGED,
  addPropertyValue,
  addTag,
  bindingLabel,
  cardMembership,
  categorizeSkipReason,
  definitionOptionValues,
  diffMembership,
  frameAtPoint,
  getFrameBindings,
  getFrames,
  layoutOrigin,
  placeInFrame,
  planPropertyLayout,
  readFrameBinding,
  removePropertyValue,
  removeTag,
  withFrameBinding,
  type FrameBinding,
  type FrameSceneElement
} from './canvas-frame-binding'

const card = (
  id: string,
  entityId: string,
  frameId: string | null = null,
  extra: Partial<FrameSceneElement> = {}
): FrameSceneElement => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 260,
  height: 168,
  angle: 0,
  frameId,
  customData: { entityType: 'note', entityId },
  ...extra
})

const frame = (
  id: string,
  binding: FrameBinding | null = null,
  extra: Partial<FrameSceneElement> = {}
): FrameSceneElement => ({
  id,
  type: 'frame',
  x: 0,
  y: 0,
  width: 600,
  height: 400,
  angle: 0,
  name: null,
  customData: binding ? { [FRAME_BINDING_KEY]: binding } : null,
  ...extra
})

const tagBinding: FrameBinding = { kind: 'tag', tag: 'health/sleep' }
const statusBinding: FrameBinding = {
  kind: 'property',
  property: 'Status',
  value: 'Done',
  propertyType: 'status'
}
const multiBinding: FrameBinding = {
  kind: 'property',
  property: 'Topics',
  value: 'sleep',
  propertyType: 'multiselect'
}

describe('readFrameBinding / withFrameBinding', () => {
  it('round-trips a binding and keeps unrelated customData keys', () => {
    const data = withFrameBinding({ other: 1 }, tagBinding)
    expect(data).toEqual({ other: 1, [FRAME_BINDING_KEY]: tagBinding })
    expect(readFrameBinding(data)).toEqual(tagBinding)
    expect(withFrameBinding(data, null)).toEqual({ other: 1 })
  })

  it('returns undefined customData when nothing is left', () => {
    expect(withFrameBinding({ [FRAME_BINDING_KEY]: tagBinding }, null)).toBeUndefined()
  })

  it('reads malformed or unknown bindings as unbound', () => {
    expect(readFrameBinding(null)).toBeNull()
    expect(readFrameBinding({ [FRAME_BINDING_KEY]: { kind: 'tag', tag: '' } })).toBeNull()
    expect(readFrameBinding({ [FRAME_BINDING_KEY]: { kind: 'folder', path: 'x' } })).toBeNull()
    expect(
      readFrameBinding({
        [FRAME_BINDING_KEY]: { ...statusBinding, propertyType: 'text' }
      })
    ).toBeNull()
    expect(readFrameBinding({ [FRAME_BINDING_KEY]: statusBinding })).toEqual(statusBinding)
  })

  it('labels bindings', () => {
    expect(bindingLabel(tagBinding)).toBe('#health/sleep')
    expect(bindingLabel(statusBinding)).toBe('Status: Done')
  })
})

describe('getFrames / getFrameBindings', () => {
  it('counts live cards per frame and skips deleted frames', () => {
    const elements = [
      card('c1', 'n1', 'f1'),
      card('c2', 'n2', 'f1'),
      card('c3', 'n3', 'f1', { isDeleted: true }),
      { ...card('s1', 'x', 'f1'), customData: null },
      frame('f1', tagBinding),
      frame('f2', null, { isDeleted: true })
    ]
    const frames = getFrames(elements)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ id: 'f1', cardCount: 2, binding: tagBinding })
    expect([...getFrameBindings(elements).keys()]).toEqual(['f1'])
  })
})

describe('diffMembership', () => {
  it('reports cards that changed frame, including new cards inside a frame', () => {
    const before = cardMembership([card('c1', 'n1'), card('c2', 'n2', 'f1'), card('c3', 'n3')])
    const after = cardMembership([
      card('c1', 'n1', 'f1', { x: 50, y: 60 }),
      card('c2', 'n2', null),
      card('c3', 'n3'),
      card('c4', 'n4', 'f1'),
      card('c5', 'n5')
    ])
    const changes = diffMembership(before, after)
    expect(changes).toEqual([
      {
        elementId: 'c1',
        entityType: 'note',
        entityId: 'n1',
        fromFrameId: null,
        toFrameId: 'f1',
        before: { x: 0, y: 0 }
      },
      {
        elementId: 'c2',
        entityType: 'note',
        entityId: 'n2',
        fromFrameId: 'f1',
        toFrameId: null,
        before: { x: 0, y: 0 }
      },
      {
        elementId: 'c4',
        entityType: 'note',
        entityId: 'n4',
        fromFrameId: null,
        toFrameId: 'f1',
        before: null
      }
    ])
  })

  it('ignores cards that disappeared', () => {
    const before = cardMembership([card('c1', 'n1', 'f1')])
    const after = cardMembership([card('c1', 'n1', 'f1', { isDeleted: true })])
    expect(diffMembership(before, after)).toEqual([])
  })
})

describe('category math', () => {
  it('adds and removes tags case-insensitively', () => {
    expect(addTag(['a'], 'health/sleep')).toEqual(['a', 'health/sleep'])
    expect(addTag(['Health/Sleep'], 'health/sleep')).toBeNull()
    expect(removeTag(['a', 'Health/Sleep'], 'health/sleep')).toEqual(['a'])
    expect(removeTag(['a'], 'b')).toBeNull()
  })

  it('replaces single-value properties and appends to multi-select', () => {
    expect(addPropertyValue('Not started', statusBinding)).toBe('Done')
    expect(addPropertyValue('Done', statusBinding)).toBe(UNCHANGED)
    expect(addPropertyValue(['diet'], multiBinding)).toEqual(['diet', 'sleep'])
    expect(addPropertyValue('diet', multiBinding)).toEqual(['diet', 'sleep'])
    expect(addPropertyValue(undefined, multiBinding)).toEqual(['sleep'])
    expect(addPropertyValue(['sleep'], multiBinding)).toBe(UNCHANGED)
  })

  it('only clears a single-value property that still holds the bound value', () => {
    expect(removePropertyValue('Done', statusBinding)).toBeNull()
    expect(removePropertyValue('In Progress', statusBinding)).toBe(UNCHANGED)
    expect(removePropertyValue(['diet', 'sleep'], multiBinding)).toEqual(['diet'])
    expect(removePropertyValue(['sleep'], multiBinding)).toBeNull()
    expect(removePropertyValue(['diet'], multiBinding)).toBe(UNCHANGED)
  })

  it('explains which cards cannot take a binding', () => {
    expect(categorizeSkipReason('note', statusBinding)).toBeNull()
    expect(categorizeSkipReason('task', tagBinding)).toBeNull()
    expect(categorizeSkipReason('task', statusBinding)).toBe('taskProperty')
    expect(categorizeSkipReason('file', tagBinding)).toBe('file')
    expect(categorizeSkipReason('project', tagBinding)).toBe('unsupported')
  })
})

describe('definitionOptionValues', () => {
  it('reads select options in either stored shape', () => {
    expect(
      definitionOptionValues('select', JSON.stringify([{ value: 'a', color: 'red' }, 'b', {}]))
    ).toEqual(['a', 'b'])
    expect(definitionOptionValues('multiselect', 'not json')).toEqual([])
    expect(definitionOptionValues('select', null)).toEqual([])
  })

  it('flattens status categories in category order, defaulting when absent', () => {
    expect(definitionOptionValues('status', null)).toEqual([
      'Not started',
      'In Progress',
      'Done',
      'Abandoned'
    ])
    const categories = {
      done: { label: 'Done', options: [{ value: 'Shipped', color: 'green' }] },
      todo: { label: 'Todo', options: [{ value: 'Idea', color: 'stone' }] },
      in_progress: { label: 'Doing', options: [] }
    }
    expect(definitionOptionValues('status', JSON.stringify({ categories }))).toEqual([
      'Idea',
      'Shipped'
    ])
  })
})

describe('planPropertyLayout', () => {
  it('creates one frame per option and grids the cards of the first matching option', () => {
    const plan = planPropertyLayout({
      options: ['Todo', 'Done', 'Empty'],
      cards: [
        { elementId: 'a', width: 100, height: 50, values: ['Todo'] },
        { elementId: 'b', width: 100, height: 50, values: ['Done', 'Todo'] },
        { elementId: 'c', width: 100, height: 50, values: ['Other'] },
        { elementId: 'd', width: 100, height: 50, values: ['Todo'] }
      ],
      origin: { x: 1000, y: 0 }
    })
    expect(plan.frames.map((f) => [f.value, f.childIds])).toEqual([
      ['Todo', ['a', 'b', 'd']],
      ['Done', []],
      ['Empty', []]
    ])
    expect(plan.moves.has('c')).toBe(false)
    expect(plan.moves.get('a')).toEqual({
      x: 1000 + LAYOUT_FRAME_PADDING,
      y: LAYOUT_FRAME_PADDING
    })
    const todo = plan.frames[0]
    // 3 cards → 2 columns × 2 rows.
    expect(todo.width).toBe(LAYOUT_FRAME_PADDING * 2 + 2 * 100 + 24)
    expect(todo.height).toBe(LAYOUT_FRAME_PADDING * 2 + 2 * 50 + 24)
    expect(plan.frames[1].width).toBe(LAYOUT_EMPTY_FRAME.width)
    expect(plan.frames[1].x).toBeGreaterThan(todo.x + todo.width)
  })

  it('starts right of existing content, or at the fallback on an empty scene', () => {
    expect(layoutOrigin([], { x: 5, y: 6 })).toEqual({ x: 5, y: 6 })
    expect(layoutOrigin([card('c1', 'n1', null, { x: 10, y: -20 })], { x: 0, y: 0 })).toEqual({
      x: 10 + 260 + 120,
      y: -20
    })
  })
})

describe('frameAtPoint / placeInFrame', () => {
  it('finds the topmost frame under a point', () => {
    const elements = [frame('f1'), frame('f2', null, { x: 100, y: 100 })]
    expect(frameAtPoint(elements, { x: 150, y: 150 })).toBe('f2')
    expect(frameAtPoint(elements, { x: 50, y: 50 })).toBe('f1')
    expect(frameAtPoint(elements, { x: 5000, y: 5000 })).toBeNull()
  })

  it('moves children right before their frame and bumps their version', () => {
    const elements = [frame('f1'), card('c1', 'n1', null, { version: 3 }), card('c2', 'n2')]
    const next = placeInFrame(elements, new Set(['c1']), 'f1')
    expect(next.map((el) => el.id)).toEqual(['c1', 'f1', 'c2'])
    expect(next[0].frameId).toBe('f1')
    expect(next[0].version).toBe(4)
  })
})
