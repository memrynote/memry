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
  markUpdateInstallStarted
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
})
