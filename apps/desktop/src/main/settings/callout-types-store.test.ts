import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readCalloutRun, setCalloutTypeDefinitions } from '@memry/editor-schema/blocks'
import type { DataDb } from '../database/types'

const mocks = vi.hoisted(() => ({
  rows: new Map<string, string>(),
  syncSettingsFieldUpdate: vi.fn()
}))

vi.mock('../database/queries/settings', () => ({
  getSetting: (_db: unknown, key: string) => mocks.rows.get(key) ?? null,
  setSetting: (_db: unknown, key: string, value: string) => {
    mocks.rows.set(key, value)
  }
}))

vi.mock('../sync/local-mutations', () => ({
  syncSettingsFieldUpdate: mocks.syncSettingsFieldUpdate
}))

import {
  CALLOUT_TYPES_SETTINGS_KEY,
  applyMergedCalloutTypes,
  readCalloutTypes,
  writeCalloutTypes
} from './callout-types-store'

const db = {} as DataDb
const mytype = { name: 'mytype', label: 'My type', color: '#ff8800', icon: 'star' }
const other = { name: 'other', label: 'Other', color: '#0088ff', icon: 'bolt' }
const claimsMytype = (): boolean => readCalloutRun(['> [!mytype]', '> body'], 0, true) !== null

describe('callout-types-store (#3207)', () => {
  beforeEach(() => {
    mocks.rows.clear()
    vi.clearAllMocks()
  })
  afterEach(() => setCalloutTypeDefinitions([]))

  it('reads no types from an absent or corrupt row', () => {
    expect(readCalloutTypes(db)).toEqual([])
    mocks.rows.set(CALLOUT_TYPES_SETTINGS_KEY, '{not json')
    expect(readCalloutTypes(db)).toEqual([])
  })

  it('loads the stored types into the parser registry on read', () => {
    mocks.rows.set(CALLOUT_TYPES_SETTINGS_KEY, JSON.stringify({ mytype }))
    expect(claimsMytype()).toBe(false)

    expect(readCalloutTypes(db)).toEqual([mytype])
    expect(claimsMytype()).toBe(true)
  })

  it('syncs one field path per changed type and null for a deleted one', () => {
    writeCalloutTypes(db, [mytype, other])
    expect(mocks.syncSettingsFieldUpdate).toHaveBeenCalledWith('editor.calloutTypes.mytype', mytype)
    expect(mocks.syncSettingsFieldUpdate).toHaveBeenCalledWith('editor.calloutTypes.other', other)
    expect(claimsMytype()).toBe(true)

    mocks.syncSettingsFieldUpdate.mockClear()
    writeCalloutTypes(db, [other])

    expect(mocks.syncSettingsFieldUpdate).toHaveBeenCalledTimes(1)
    expect(mocks.syncSettingsFieldUpdate).toHaveBeenCalledWith('editor.calloutTypes.mytype', null)
    expect(claimsMytype()).toBe(false)
  })

  it('refuses a type that shadows a built-in or has a bad colour', () => {
    const next = writeCalloutTypes(db, [
      { ...mytype, name: 'info' },
      { ...other, color: 'blue' },
      mytype
    ])

    expect(next).toEqual([mytype])
    expect(mocks.syncSettingsFieldUpdate).toHaveBeenCalledTimes(1)
  })

  it('merges an inbound map without dropping a local-only type', () => {
    mocks.rows.set(CALLOUT_TYPES_SETTINGS_KEY, JSON.stringify({ mytype }))

    const next = applyMergedCalloutTypes(db, { other, mytype: null, junk: 'x' })

    expect(next).toEqual([other])
    expect(readCalloutTypes(db)).toEqual([other])
    expect(claimsMytype()).toBe(false)
  })

  it('keeps a local-only type when the inbound map does not mention it', () => {
    mocks.rows.set(CALLOUT_TYPES_SETTINGS_KEY, JSON.stringify({ mytype }))

    expect(applyMergedCalloutTypes(db, { other })).toEqual([mytype, other])
  })
})
