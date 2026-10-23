import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { mockApp } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  app: mockApp
}))

vi.mock('./track', () => ({
  trackMainEvent: vi.fn()
}))

import {
  UPDATE_INSTALL_MARKER_FILENAME,
  detectFailedUpdateInstall,
  markUpdateInstallStarted,
  resolveUpdateInstallOutcome
} from './update-install-marker'
import { trackMainEvent } from './track'

describe('update install marker', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-update-install-'))
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'userData' ? tempDir : `/mock/${name}`
    )
    vi.mocked(trackMainEvent).mockClear()
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const markerFile = (): string => path.join(tempDir, UPDATE_INSTALL_MARKER_FILENAME)

  it('reports nothing when no install was ever attempted', () => {
    // #given no marker on disk
    // #when the app boots
    detectFailedUpdateInstall('2026.807.2')

    // #then nothing is reported
    expect(trackMainEvent).not.toHaveBeenCalled()
  })

  it('reports nothing when the next launch runs the new version (install applied)', () => {
    // #given an install handed off from 2026.806.2
    markUpdateInstallStarted('2026.806.2', 'v2026-08-07.2')

    // #when the app boots as the new build
    detectFailedUpdateInstall('2026.807.2')

    // #then the install succeeded, so nothing is reported
    expect(trackMainEvent).not.toHaveBeenCalled()
  })

  it('reports the failure when the next launch still runs the old version', () => {
    // #given an install handed off from 2026.806.2 to v2026-08-07.2
    markUpdateInstallStarted('2026.806.2', 'v2026-08-07.2')

    // #when the app boots as the SAME old build — the installer never applied
    detectFailedUpdateInstall('2026.806.2')

    // #then the silent install failure reaches error tracking
    expect(trackMainEvent).toHaveBeenCalledWith(
      'app_error_seen',
      expect.objectContaining({
        surface: 'app',
        action: 'install',
        source: 'updater',
        result: 'failed',
        errorCode: 'UPDATE_INSTALL_DID_NOT_APPLY',
        dimensions: {
          prior_app_version: '2026.806.2',
          target_app_version: 'v2026-08-07.2'
        }
      })
    )
  })

  it('returns the failed attempt so the caller can surface it in-app', () => {
    // #given an install handed off from 2026.806.2 to v2026-08-07.2
    markUpdateInstallStarted('2026.806.2', 'v2026-08-07.2')

    // #when the app boots as the SAME old build
    const failed = detectFailedUpdateInstall('2026.806.2')

    // #then the attempt comes back, not just a telemetry event
    expect(failed).toMatchObject({ fromVersion: '2026.806.2', toVersion: 'v2026-08-07.2' })
  })

  it('returns null when the install applied', () => {
    // #given an install handed off from 2026.806.2
    markUpdateInstallStarted('2026.806.2', 'v2026-08-07.2')

    // #when the app boots as the new build
    // #then there is nothing to surface
    expect(detectFailedUpdateInstall('2026.807.2')).toBeNull()
  })

  it('consumes the marker so the same failure is never reported twice', () => {
    // #given a failed install already reported on the previous boot
    markUpdateInstallStarted('2026.806.2')
    detectFailedUpdateInstall('2026.806.2')
    expect(trackMainEvent).toHaveBeenCalledTimes(1)
    vi.mocked(trackMainEvent).mockClear()

    // #when the app boots again on the same version
    detectFailedUpdateInstall('2026.806.2')

    // #then the marker is gone and nothing is re-reported
    expect(fs.existsSync(markerFile())).toBe(false)
    expect(trackMainEvent).not.toHaveBeenCalled()
  })

  it('clears the marker on a successful install so a later boot cannot false-report', () => {
    // #given an install that applied
    markUpdateInstallStarted('2026.806.2')
    detectFailedUpdateInstall('2026.807.2')

    // #when the user later downgrades or reinstalls the old build
    detectFailedUpdateInstall('2026.806.2')

    // #then the stale marker is already gone, so no failure is invented
    expect(trackMainEvent).not.toHaveBeenCalled()
  })

  it('reports nothing for a corrupt marker, which cannot prove which version ran', () => {
    // #given a truncated marker (killed mid-write)
    fs.writeFileSync(markerFile(), '{"fromVersion":')

    // #when the app boots
    detectFailedUpdateInstall('2026.806.2')

    // #then it is discarded rather than guessed at
    expect(trackMainEvent).not.toHaveBeenCalled()
    expect(fs.existsSync(markerFile())).toBe(false)
  })

  it('survives an unwritable userData instead of breaking the install handoff', () => {
    // #given a userData path that cannot be written
    mockApp.getPath.mockImplementation(() => path.join(tempDir, 'does', 'not', 'exist'))

    // #when the install handoff records its attempt
    // #then the write failure never propagates
    expect(() => markUpdateInstallStarted('2026.806.2')).not.toThrow()
  })

  describe('installer hand-off outcomes', () => {
    it('round-trips the installer and names it as the source of a failed install', () => {
      markUpdateInstallStarted('2026.806.2', 'v2026-08-07.2', 'velopack-handoff')

      const failed = detectFailedUpdateInstall('2026.806.2', () => 'nsis')

      expect(failed).toMatchObject({ fromVersion: '2026.806.2', installer: 'velopack-handoff' })
      expect(trackMainEvent).toHaveBeenCalledWith(
        'app_error_seen',
        expect.objectContaining({
          source: 'velopack-handoff',
          errorCode: 'UPDATE_INSTALL_DID_NOT_APPLY',
          dimensions: {
            prior_app_version: '2026.806.2',
            target_app_version: 'v2026-08-07.2'
          }
        })
      )
    })

    it('reports a migrated install when the new build runs from the Velopack layout', () => {
      markUpdateInstallStarted('2026.806.2', 'v2026-08-07.2', 'velopack-handoff')

      const result = detectFailedUpdateInstall('2026.807.2', () => 'velopack')

      expect(result).toBeNull()
      expect(trackMainEvent).toHaveBeenCalledTimes(1)
      expect(trackMainEvent).toHaveBeenCalledWith('app_update_installed', {
        surface: 'updater',
        action: 'migrated',
        source: 'velopack-handoff',
        result: 'success',
        dimensions: { from_version: '2026.806.2' }
      })
    })

    it('reports a hand-off that fell back to NSIS when the new build is not a Velopack install', () => {
      markUpdateInstallStarted('2026.806.2', 'v2026-08-07.2', 'velopack-handoff')

      const result = detectFailedUpdateInstall('2026.807.2', () => 'nsis')

      expect(result).toBeNull()
      expect(trackMainEvent).toHaveBeenCalledTimes(1)
      expect(trackMainEvent).toHaveBeenCalledWith('app_error_seen', {
        surface: 'app',
        action: 'install',
        objectType: 'exception',
        source: 'velopack-handoff',
        result: 'failed',
        errorCode: 'INSTALLER_HANDOFF_DID_NOT_APPLY',
        dimensions: { prior_app_version: '2026.806.2' }
      })
    })

    it('reports a plain installer hand-off as before, whatever the layout', () => {
      markUpdateInstallStarted('2026.806.2', 'v2026-08-07.2', 'electron-updater')

      expect(detectFailedUpdateInstall('2026.807.2', () => 'velopack')).toBeNull()
      expect(trackMainEvent).not.toHaveBeenCalled()

      markUpdateInstallStarted('2026.806.2', 'v2026-08-07.2', 'electron-updater')
      detectFailedUpdateInstall('2026.806.2', () => 'nsis')
      expect(trackMainEvent).toHaveBeenCalledWith(
        'app_error_seen',
        expect.objectContaining({
          source: 'electron-updater',
          errorCode: 'UPDATE_INSTALL_DID_NOT_APPLY'
        })
      )
    })

    it('reads a marker written by an older build that never recorded the installer', () => {
      fs.writeFileSync(
        markerFile(),
        JSON.stringify({ fromVersion: '2026.806.2', toVersion: 'v2026-08-07.2', startedAt: '' })
      )

      expect(detectFailedUpdateInstall('2026.807.2', () => 'velopack')).toBeNull()
      expect(trackMainEvent).not.toHaveBeenCalled()

      fs.writeFileSync(markerFile(), JSON.stringify({ fromVersion: '2026.806.2', startedAt: '' }))
      const failed = detectFailedUpdateInstall('2026.806.2', () => 'nsis')

      expect(failed).toEqual({ fromVersion: '2026.806.2', toVersion: undefined, startedAt: '' })
      expect(trackMainEvent).toHaveBeenCalledWith(
        'app_error_seen',
        expect.objectContaining({ source: 'updater', errorCode: 'UPDATE_INSTALL_DID_NOT_APPLY' })
      )
    })

    it('ignores an installer value it does not know', () => {
      fs.writeFileSync(
        markerFile(),
        JSON.stringify({ fromVersion: '2026.806.2', startedAt: '', installer: 'squirrel' })
      )

      expect(detectFailedUpdateInstall('2026.806.2', () => 'unknown')).toEqual({
        fromVersion: '2026.806.2',
        toVersion: undefined,
        startedAt: ''
      })
    })
  })

  describe('resolveUpdateInstallOutcome', () => {
    const attempt = (installer?: 'electron-updater' | 'velopack' | 'velopack-handoff') => ({
      fromVersion: '2026.806.2',
      startedAt: '',
      ...(installer ? { installer } : {})
    })

    it.each([
      [attempt('velopack-handoff'), '2026.806.2', 'velopack', 'did-not-apply'],
      [attempt('velopack-handoff'), '2026.807.2', 'velopack', 'handoff-applied'],
      [attempt('velopack-handoff'), '2026.807.2', 'nsis', 'handoff-fell-back'],
      [attempt('velopack-handoff'), '2026.807.2', 'unknown', 'handoff-fell-back'],
      [attempt('electron-updater'), '2026.807.2', 'nsis', 'applied'],
      [attempt('velopack'), '2026.807.2', 'velopack', 'applied'],
      [attempt(), '2026.807.2', 'velopack', 'applied'],
      [attempt(), '2026.806.2', 'unknown', 'did-not-apply']
    ] as const)('%o on %s from a %s layout is %s', (marker, currentVersion, layout, outcome) => {
      expect(resolveUpdateInstallOutcome(marker, currentVersion, () => layout)).toBe(outcome)
    })
  })
})
