import { describe, it, expect, beforeEach } from 'vitest'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { stashReleaseNotes, takeReleaseNotesTabPlan } from './release-notes-tab'

function state(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    currentVersion: '2026.700.1',
    status: 'downloaded',
    updateSupported: true,
    availableVersion: '2026.708.1',
    releaseName: null,
    releaseDate: null,
    releaseNotes: 'plain notes',
    releaseNotesHtml: '<p>notes</p>',
    downloadProgressPercent: null,
    lastCheckedAt: null,
    error: null,
    autoDownloadEnabled: false,
    autoCheckEnabled: true,
    ...overrides
  }
}

describe('release-notes tab stash', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows the notes only after the app restarts on the new version, once', () => {
    stashReleaseNotes(state())

    // Pre-restart session: still the old version, nothing to show.
    expect(takeReleaseNotesTabPlan('2026.700.1')).toBeNull()

    expect(takeReleaseNotesTabPlan('2026.708.1')).toEqual({
      version: '2026.708.1',
      title: 'MemryNote 2026.708.1',
      content: '<p>notes</p>',
      contentType: 'html'
    })
    // Consumed: a later restart must not re-open it.
    expect(takeReleaseNotesTabPlan('2026.708.1')).toBeNull()
  })

  it('falls back to plain notes and ignores updates with nothing to show', () => {
    stashReleaseNotes(state({ releaseNotesHtml: null }))
    expect(takeReleaseNotesTabPlan('v2026.708.1')).toMatchObject({ contentType: 'markdown' })

    stashReleaseNotes(state({ releaseNotes: null, releaseNotesHtml: null }))
    stashReleaseNotes(state({ availableVersion: null }))
    stashReleaseNotes(state({ updateSupported: false }))
    expect(takeReleaseNotesTabPlan('2026.708.1')).toBeNull()
  })

  it('drops a corrupt stash instead of throwing', () => {
    localStorage.setItem('memry:release-notes-pending', '{not json')
    expect(takeReleaseNotesTabPlan('2026.708.1')).toBeNull()
    expect(localStorage.getItem('memry:release-notes-pending')).toBeNull()
  })
})
