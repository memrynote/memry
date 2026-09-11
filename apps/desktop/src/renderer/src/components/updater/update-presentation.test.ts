import { describe, it, expect } from 'vitest'
import type { AppUpdateState, UpdaterStatus } from '@memry/contracts/ipc-updater'
import { toUpdatePresentation } from './update-presentation'

function state(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    currentVersion: '2026.700.1',
    status: 'idle',
    updateSupported: true,
    availableVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    releaseNotesHtml: null,
    downloadProgressPercent: null,
    lastCheckedAt: null,
    error: null,
    autoDownloadEnabled: false,
    autoCheckEnabled: true,
    installFailed: null,
    ...overrides
  }
}

describe('toUpdatePresentation', () => {
  it('hides everything where updates are not supported', () => {
    expect(
      toUpdatePresentation(
        state({ updateSupported: false, status: 'downloaded', availableVersion: '2026.999.9' })
      )
    ).toEqual({ kind: 'hidden' })
  })

  it('reports installing above every other phase', () => {
    expect(
      toUpdatePresentation(
        state({
          status: 'installing',
          availableVersion: '2026.999.9',
          installFailed: { version: '2026.998.1' }
        })
      )
    ).toEqual({ kind: 'installing', version: '2026.999.9' })
  })

  it('reports installing without a version', () => {
    expect(toUpdatePresentation(state({ status: 'installing' }))).toEqual({
      kind: 'installing',
      version: null
    })
  })

  it('reports a failed install above a newly available update', () => {
    expect(
      toUpdatePresentation(
        state({
          status: 'available',
          availableVersion: '2026.999.9',
          installFailed: { version: '2026.998.1' }
        })
      )
    ).toEqual({ kind: 'failed', version: '2026.998.1' })
  })

  it('reports a failed install whose version was never recorded', () => {
    expect(toUpdatePresentation(state({ installFailed: { version: null } }))).toEqual({
      kind: 'failed',
      version: null
    })
  })

  it('offers an available update the user must start themselves', () => {
    expect(
      toUpdatePresentation(state({ status: 'available', availableVersion: '2026.999.9' }))
    ).toEqual({ kind: 'available', version: '2026.999.9' })
  })

  it('stays silent on an available update that will download itself', () => {
    expect(
      toUpdatePresentation(
        state({ status: 'available', availableVersion: '2026.999.9', autoDownloadEnabled: true })
      )
    ).toEqual({ kind: 'hidden' })
  })

  it('reports download progress the user asked for', () => {
    expect(
      toUpdatePresentation(
        state({
          status: 'downloading',
          availableVersion: '2026.999.9',
          downloadProgressPercent: 42
        })
      )
    ).toEqual({ kind: 'downloading', version: '2026.999.9', percent: 42 })
  })

  it('reports a download with no progress yet', () => {
    expect(
      toUpdatePresentation(state({ status: 'downloading', availableVersion: '2026.999.9' }))
    ).toEqual({ kind: 'downloading', version: '2026.999.9', percent: null })
  })

  it('clamps a progress percent that ran outside 0..100', () => {
    expect(
      toUpdatePresentation(
        state({
          status: 'downloading',
          availableVersion: '2026.999.9',
          downloadProgressPercent: 140
        })
      )
    ).toEqual({ kind: 'downloading', version: '2026.999.9', percent: 100 })
    expect(
      toUpdatePresentation(
        state({
          status: 'downloading',
          availableVersion: '2026.999.9',
          downloadProgressPercent: -5
        })
      )
    ).toEqual({ kind: 'downloading', version: '2026.999.9', percent: 0 })
  })

  it('stays silent while a background download the app started runs', () => {
    expect(
      toUpdatePresentation(
        state({
          status: 'downloading',
          availableVersion: '2026.999.9',
          autoDownloadEnabled: true,
          downloadProgressPercent: 42
        })
      )
    ).toEqual({ kind: 'hidden' })
  })

  it('reports a downloaded update even when it downloaded itself', () => {
    expect(
      toUpdatePresentation(
        state({ status: 'downloaded', availableVersion: '2026.999.9', autoDownloadEnabled: true })
      )
    ).toEqual({ kind: 'ready', version: '2026.999.9' })
  })

  it.each<UpdaterStatus>(['available', 'downloading', 'downloaded'])(
    'hides %s when the version is unknown',
    (status) => {
      expect(toUpdatePresentation(state({ status, availableVersion: null }))).toEqual({
        kind: 'hidden'
      })
    }
  )

  it.each<UpdaterStatus>(['idle', 'checking', 'up-to-date', 'error', 'unavailable'])(
    'hides the %s phase',
    (status) => {
      expect(toUpdatePresentation(state({ status, availableVersion: '2026.999.9' }))).toEqual({
        kind: 'hidden'
      })
    }
  )

  it('treats a missing installFailed field from an older main as no failure', () => {
    const older = state({ status: 'downloaded', availableVersion: '2026.999.9' })
    delete older.installFailed
    expect(toUpdatePresentation(older)).toEqual({ kind: 'ready', version: '2026.999.9' })
  })
})
