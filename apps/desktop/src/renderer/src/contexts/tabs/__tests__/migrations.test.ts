import { describe, it, expect } from 'vitest'
import { migrateLayout, migratePersistedState } from '../persistence/migrations'
import type { PersistedTabState } from '../persistence/types'

describe('migrateLayout', () => {
  it('passes through leaf nodes unchanged', () => {
    const leaf = { type: 'leaf' as const, tabGroupId: 'g1' }
    expect(migrateLayout(leaf)).toEqual(leaf)
  })

  it('converts horizontal type to split+direction', () => {
    // #given — old format
    const old = {
      type: 'horizontal',
      ratio: 0.4,
      first: { type: 'leaf', tabGroupId: 'g1' },
      second: { type: 'leaf', tabGroupId: 'g2' }
    }

    // #when
    const result = migrateLayout(old)

    // #then
    expect(result).toEqual({
      type: 'split',
      direction: 'horizontal',
      ratio: 0.4,
      first: { type: 'leaf', tabGroupId: 'g1' },
      second: { type: 'leaf', tabGroupId: 'g2' }
    })
  })

  it('converts vertical type to split+direction', () => {
    const old = {
      type: 'vertical',
      ratio: 0.6,
      first: { type: 'leaf', tabGroupId: 'g1' },
      second: { type: 'leaf', tabGroupId: 'g2' }
    }

    const result = migrateLayout(old)

    expect(result).toEqual({
      type: 'split',
      direction: 'vertical',
      ratio: 0.6,
      first: { type: 'leaf', tabGroupId: 'g1' },
      second: { type: 'leaf', tabGroupId: 'g2' }
    })
  })

  it('recursively migrates nested old-format layouts', () => {
    const old = {
      type: 'horizontal',
      ratio: 0.5,
      first: {
        type: 'vertical',
        ratio: 0.3,
        first: { type: 'leaf', tabGroupId: 'g1' },
        second: { type: 'leaf', tabGroupId: 'g2' }
      },
      second: { type: 'leaf', tabGroupId: 'g3' }
    }

    const result = migrateLayout(old)

    expect(result).toEqual({
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.3,
        first: { type: 'leaf', tabGroupId: 'g1' },
        second: { type: 'leaf', tabGroupId: 'g2' }
      },
      second: { type: 'leaf', tabGroupId: 'g3' }
    })
  })

  it('passes through already-new-format layouts', () => {
    const newFormat = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      ratio: 0.5,
      first: { type: 'leaf' as const, tabGroupId: 'g1' },
      second: { type: 'leaf' as const, tabGroupId: 'g2' }
    }

    expect(migrateLayout(newFormat)).toEqual(newFormat)
  })

  it('defaults ratio to 0.5 when missing', () => {
    const old = {
      type: 'horizontal',
      first: { type: 'leaf', tabGroupId: 'g1' },
      second: { type: 'leaf', tabGroupId: 'g2' }
    }

    const result = migrateLayout(old)
    expect(result).toHaveProperty('ratio', 0.5)
  })
})

describe('migratePersistedState', () => {
  const makePersistedState = (overrides: Partial<PersistedTabState> = {}): PersistedTabState => ({
    version: 0,
    tabGroups: {
      g1: {
        id: 'g1',
        tabs: [
          {
            id: 't1',
            type: 'inbox',
            title: 'Inbox',
            icon: 'inbox',
            path: '/inbox',
            isPinned: false
          }
        ],
        activeTabId: 't1'
      }
    },
    layout: { type: 'leaf', tabGroupId: 'g1' },
    activeGroupId: 'g1',
    settings: {
      previewMode: false,
      restoreSessionOnStart: true,
      tabCloseButton: 'hover'
    },
    savedAt: Date.now(),
    ...overrides
  })

  it('skips migration for current version', () => {
    const state = makePersistedState({ version: 2 })
    expect(migratePersistedState(state)).toEqual(state)
  })

  it('migrates v0→v2 adding viewState and converting layout', () => {
    const state = makePersistedState({
      version: 0,
      layout: {
        type: 'horizontal' as never,
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: 'g1' },
        second: { type: 'leaf', tabGroupId: 'g2' }
      } as never
    })

    const result = migratePersistedState(state)

    expect(result.version).toBe(2)
    expect(result.tabGroups.g1.tabs[0].viewState).toEqual({})
    expect(result.layout).toEqual({
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', tabGroupId: 'g1' },
      second: { type: 'leaf', tabGroupId: 'g2' }
    })
  })

  it('migrates v1→v2 converting layout only', () => {
    const state = makePersistedState({
      version: 1,
      layout: {
        type: 'vertical' as never,
        ratio: 0.6,
        first: { type: 'leaf', tabGroupId: 'g1' },
        second: { type: 'leaf', tabGroupId: 'g2' }
      } as never
    })

    const result = migratePersistedState(state)

    expect(result.version).toBe(2)
    expect(result.layout).toEqual({
      type: 'split',
      direction: 'vertical',
      ratio: 0.6,
      first: { type: 'leaf', tabGroupId: 'g1' },
      second: { type: 'leaf', tabGroupId: 'g2' }
    })
  })
})
