import { describe, expect, it } from 'vitest'
import type { AppUpdateState, UpdaterStatus } from '@memry/contracts/ipc-updater'
import { shouldShowUpdatePrompt } from './update-prompt-dialog'

function state(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    currentVersion: '2026.700.1',
    status: 'available',
    updateSupported: true,
    availableVersion: '2026.708.1',
    releaseName: null,
    releaseDate: null,
    releaseNotes: 'notes',
    releaseNotesHtml: '<p>notes</p>',
    downloadProgressPercent: null,
    lastCheckedAt: null,
    error: null,
    autoDownloadEnabled: false,
    autoCheckEnabled: true,
    ...overrides
  }
}

describe('shouldShowUpdatePrompt', () => {
  it('shows the available prompt when auto-download is off', () => {
    expect(shouldShowUpdatePrompt(state({ status: 'available' }), null)).toBe(true)
  })

  it('shows the downloaded prompt when auto-download is off', () => {
    expect(shouldShowUpdatePrompt(state({ status: 'downloaded' }), null)).toBe(true)
  })

  it('stays silent for BOTH phases when auto-download is on (no popup)', () => {
    expect(
      shouldShowUpdatePrompt(state({ status: 'available', autoDownloadEnabled: true }), null)
    ).toBe(false)
    expect(
      shouldShowUpdatePrompt(state({ status: 'downloaded', autoDownloadEnabled: true }), null)
    ).toBe(false)
  })

  it('hides a phase the user dismissed', () => {
    expect(shouldShowUpdatePrompt(state({ status: 'available' }), 'available')).toBe(false)
  })

  it('never shows when updates are unsupported or there is nothing to prompt', () => {
    expect(shouldShowUpdatePrompt(state({ updateSupported: false }), null)).toBe(false)
    for (const status of [
      'idle',
      'checking',
      'downloading',
      'up-to-date',
      'error'
    ] as UpdaterStatus[]) {
      expect(shouldShowUpdatePrompt(state({ status }), null)).toBe(false)
    }
  })
})
