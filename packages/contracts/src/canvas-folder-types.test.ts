import { describe, expect, it } from 'vitest'
import { canvasFolderSyncId } from './canvas-folder-types'

describe('canvasFolderSyncId', () => {
  it('is deterministic for the same path', () => {
    expect(canvasFolderSyncId('Work')).toBe(canvasFolderSyncId('Work'))
  })

  it('collapses case and unicode form, so two devices mint one row', () => {
    expect(canvasFolderSyncId('work')).toBe(canvasFolderSyncId('Work'))
    expect(canvasFolderSyncId('Yağmur'.normalize('NFD'))).toBe(
      canvasFolderSyncId('Yağmur'.normalize('NFC'))
    )
  })

  it('distinguishes nested paths from their parents', () => {
    expect(canvasFolderSyncId('Work/Q3')).not.toBe(canvasFolderSyncId('Work'))
  })

  it('carries the cvf_ prefix the migration SQL is written against', () => {
    expect(canvasFolderSyncId('Work/Q3')).toBe('cvf_work/q3')
  })
})
