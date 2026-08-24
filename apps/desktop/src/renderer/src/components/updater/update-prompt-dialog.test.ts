import { describe, expect, it } from 'vitest'
import type { AppUpdateState, UpdaterStatus } from '@memry/contracts/ipc-updater'
import { shouldShowUpdatePrompt } from './update-prompt-dialog'

function state(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    currentVersion: '2026.700.1',
    status: 'downloaded',
    updateSupported: true,
    availableVersion: '2026.708.1',
    releaseName: null,
    releaseDate: null,
    releaseNotes: 'notes',
    releaseNotesHtml: '<p>notes</p>',
    downloadProgressPercent: null,
    lastCheckedAt: null,
    error: null,
    autoCheckEnabled: true,
    ...overrides
  }
}

describe('shouldShowUpdatePrompt', () => {
  it('shows the restart prompt once an update finished downloading', () => {
    expect(shouldShowUpdatePrompt(state(), null)).toBe(true)
  })

  // Downloads are silent by design: the user first hears about an update when a
  // restart can apply it, never while it is found or downloading.
  it('stays silent through the available and downloading phases', () => {
    expect(shouldShowUpdatePrompt(state({ status: 'available' }), null)).toBe(false)
    expect(shouldShowUpdatePrompt(state({ status: 'downloading' }), null)).toBe(false)
  })

  it('hides the prompt the user dismissed this session', () => {
    expect(shouldShowUpdatePrompt(state(), 'downloaded')).toBe(false)
  })

  it('never shows when updates are unsupported or there is nothing to prompt', () => {
    expect(shouldShowUpdatePrompt(state({ updateSupported: false }), null)).toBe(false)
    for (const status of [
      'idle',
      'checking',
      'up-to-date',
      'installing',
      'error'
    ] as UpdaterStatus[]) {
      expect(shouldShowUpdatePrompt(state({ status }), null)).toBe(false)
    }
  })
})
