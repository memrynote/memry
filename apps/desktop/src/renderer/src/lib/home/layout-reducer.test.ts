import { describe, it, expect } from 'vitest'
import {
  addWidget,
  removeWidget,
  moveWidget,
  resizeWidget,
  configureWidget,
  updateWidgetConfig
} from './layout-reducer'
import type { HomePage, WidgetInstance } from './types'

const w = (id: string): WidgetInstance => ({ id, type: 'bookmarks', size: 'M', config: {} })
const page = (...widgets: WidgetInstance[]): HomePage => ({
  id: 'b1',
  name: 'B',
  position: 0,
  widgets
})

describe('layout-reducer', () => {
  it('addWidget appends', () => {
    expect(addWidget(page(), w('a')).widgets.map((x) => x.id)).toEqual(['a'])
  })
  it('removeWidget drops by id', () => {
    expect(removeWidget(page(w('a'), w('b')), 'a').widgets.map((x) => x.id)).toEqual(['b'])
  })
  it('moveWidget reorders active before/after over', () => {
    expect(moveWidget(page(w('a'), w('b'), w('c')), 'c', 'a').widgets.map((x) => x.id)).toEqual([
      'c',
      'a',
      'b'
    ])
  })
  it('resizeWidget changes only the target size', () => {
    const out = resizeWidget(page(w('a'), w('b')), 'a', 'L')
    expect(out.widgets.find((x) => x.id === 'a')?.size).toBe('L')
    expect(out.widgets.find((x) => x.id === 'b')?.size).toBe('M')
  })
  it('configureWidget shallow-merges config', () => {
    const out = configureWidget(page({ ...w('a'), config: { x: 1 } }), 'a', { y: 2 })
    expect(out.widgets[0].config).toEqual({ x: 1, y: 2 })
  })
  it('updateWidgetConfig replaces only the target config', () => {
    const out = updateWidgetConfig(page({ ...w('a'), config: { x: 1 } }, w('b')), 'a', { y: 2 })
    expect(out.widgets.find((x) => x.id === 'a')?.config).toEqual({ y: 2 })
    expect(out.widgets.find((x) => x.id === 'b')?.config).toEqual({})
  })
  it('reducers do not mutate the input', () => {
    const p = page(w('a'))
    addWidget(p, w('b'))
    expect(p.widgets).toHaveLength(1)
  })
})
