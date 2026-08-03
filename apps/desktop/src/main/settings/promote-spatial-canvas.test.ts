import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn()
}))

vi.mock('../database/queries/settings', () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting
}))

import { promoteSpatialCanvas, SPATIAL_CANVAS_PROMOTED_KEY } from './promote-spatial-canvas'

const db = {} as never

/** Stored settings rows, keyed the way getSetting reads them. */
function withStore(rows: Record<string, string>): void {
  mocks.getSetting.mockImplementation((_db: unknown, key: string) => rows[key] ?? null)
}

/** The `features` blob written by this run, or null when nothing was written. */
function writtenFeatures(): Record<string, unknown> | null {
  const call = mocks.setSetting.mock.calls.find(([, key]) => key === 'features')
  return call ? (JSON.parse(call[2] as string) as Record<string, unknown>) : null
}

describe('promoteSpatialCanvas', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rewrites the collateral false left by a pre-M7 feature toggle', () => {
    withStore({ features: JSON.stringify({ journal: false, spatialCanvas: false }) })

    promoteSpatialCanvas(db)

    expect(writtenFeatures()).toEqual({ journal: false, spatialCanvas: true })
  })

  it('preserves the rest of the group, including keys it does not know', () => {
    withStore({
      features: JSON.stringify({ graph: false, spatialCanvas: false, futureFlag: true })
    })

    promoteSpatialCanvas(db)

    expect(writtenFeatures()).toEqual({ graph: false, spatialCanvas: true, futureFlag: true })
  })

  it('never runs twice — an opt-out made after the promotion survives', () => {
    withStore({
      features: JSON.stringify({ spatialCanvas: false }),
      [SPATIAL_CANVAS_PROMOTED_KEY]: '1'
    })

    promoteSpatialCanvas(db)

    expect(mocks.setSetting).not.toHaveBeenCalled()
  })

  it('marks the vault promoted so the next open is a no-op', () => {
    withStore({ features: JSON.stringify({ spatialCanvas: false }) })

    promoteSpatialCanvas(db)

    expect(mocks.setSetting).toHaveBeenCalledWith(db, SPATIAL_CANVAS_PROMOTED_KEY, '1')
  })

  it('writes no features blob for a fresh vault that never stored the group', () => {
    withStore({})

    promoteSpatialCanvas(db)

    expect(writtenFeatures()).toBeNull()
    expect(mocks.setSetting).toHaveBeenCalledWith(db, SPATIAL_CANVAS_PROMOTED_KEY, '1')
  })

  it('leaves a group that never stored the key to the defaults merge', () => {
    withStore({ features: JSON.stringify({ journal: false }) })

    promoteSpatialCanvas(db)

    expect(writtenFeatures()).toBeNull()
  })

  it('leaves an already-on install untouched', () => {
    withStore({ features: JSON.stringify({ spatialCanvas: true }) })

    promoteSpatialCanvas(db)

    expect(writtenFeatures()).toBeNull()
  })

  it('marks a corrupt blob promoted without rewriting it', () => {
    withStore({ features: '{not json' })

    promoteSpatialCanvas(db)

    // The read path already reports defaults — on — for a corrupt blob, and
    // rewriting it here would destroy whatever the IPC repair path could keep.
    expect(writtenFeatures()).toBeNull()
    expect(mocks.setSetting).toHaveBeenCalledWith(db, SPATIAL_CANVAS_PROMOTED_KEY, '1')
  })
})
