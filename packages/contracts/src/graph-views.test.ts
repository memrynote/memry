import { describe, expect, it } from 'vitest'
import {
  GRAPH_VIEW_FILTER_DEFAULTS,
  GRAPH_VIEW_STATE_DEFAULTS,
  MAX_SAVED_GRAPH_VIEWS,
  parseGraphViewState,
  parseGraphViewsSettings
} from './graph-api'

const view = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `View ${id}`,
  state: GRAPH_VIEW_STATE_DEFAULTS,
  layout: 'forceatlas2',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra
})

describe('parseGraphViewState', () => {
  it('restores the default view from anything that is not an object', () => {
    expect(parseGraphViewState(undefined)).toEqual(GRAPH_VIEW_STATE_DEFAULTS)
    expect(parseGraphViewState('graph')).toEqual(GRAPH_VIEW_STATE_DEFAULTS)
    expect(parseGraphViewState(null)).toEqual(GRAPH_VIEW_STATE_DEFAULTS)
  })

  it('keeps every valid field and defaults the missing or malformed ones', () => {
    const parsed = parseGraphViewState({
      filters: { showNotes: false, focusDepth: 99, selectedTags: 'work', searchQuery: 'alpha' },
      colorBy: 'rainbow',
      collapsedCategoryIds: ['cat-1']
    })

    expect(parsed).toEqual({
      filters: {
        ...GRAPH_VIEW_FILTER_DEFAULTS,
        showNotes: false,
        searchQuery: 'alpha'
      },
      colorBy: 'type',
      collapsedCategoryIds: ['cat-1']
    })
  })

  it('ignores fields a newer build added', () => {
    const parsed = parseGraphViewState({
      ...GRAPH_VIEW_STATE_DEFAULTS,
      colorBy: 'tag-category',
      pinnedPositions: { a: { x: 1, y: 2 } }
    })
    expect(parsed).toEqual({ ...GRAPH_VIEW_STATE_DEFAULTS, colorBy: 'tag-category' })
  })
})

describe('parseGraphViewsSettings', () => {
  it('reads a vault that never stored graph views as empty', () => {
    expect(parseGraphViewsSettings(undefined)).toEqual({ views: [], lastState: null })
    expect(parseGraphViewsSettings({})).toEqual({ views: [], lastState: null })
  })

  it('drops malformed saved views one by one', () => {
    const parsed = parseGraphViewsSettings({
      views: [view('a'), { id: '', name: 'x' }, view('b', { name: '   ' }), view('c')],
      lastState: { colorBy: 'tag-category' }
    })

    expect(parsed.views.map((entry) => entry.id)).toEqual(['a', 'c'])
    expect(parsed.lastState).toEqual({ ...GRAPH_VIEW_STATE_DEFAULTS, colorBy: 'tag-category' })
  })

  it('tolerates an unknown layout on a saved view', () => {
    const parsed = parseGraphViewsSettings({ views: [view('a', { layout: 'hexagonal' })] })
    expect(parsed.views[0].layout).toBeUndefined()
  })

  it('caps the number of saved views', () => {
    const views = Array.from({ length: MAX_SAVED_GRAPH_VIEWS + 5 }, (_, i) => view(`v${i}`))
    expect(parseGraphViewsSettings({ views }).views).toHaveLength(MAX_SAVED_GRAPH_VIEWS)
  })
})
