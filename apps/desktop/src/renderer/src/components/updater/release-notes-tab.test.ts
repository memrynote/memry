import { describe, expect, it } from 'vitest'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { planReleaseNotesTab } from './release-notes-tab'

function makeState(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    currentVersion: '2026.700.1',
    status: 'available',
    updateSupported: true,
    availableVersion: '2026.708.1',
    releaseName: null,
    releaseDate: null,
    releaseNotes: 'New Features\n• A',
    releaseNotesHtml: '<h2>New Features</h2><ul><li>A</li></ul>',
    downloadProgressPercent: null,
    lastCheckedAt: null,
    error: null,
    autoDownloadEnabled: false,
    autoCheckEnabled: true,
    ...overrides
  }
}

describe('planReleaseNotesTab', () => {
  it('plans a tab titled "memry note <version>" with the full html body when an update is available', () => {
    const plan = planReleaseNotesTab(makeState(), null)
    expect(plan).toEqual({
      version: '2026.708.1',
      title: 'memry note 2026.708.1',
      content: '<h2>New Features</h2><ul><li>A</li></ul>',
      contentType: 'html'
    })
  })

  it('also plans while an opted-in update is silently downloading or downloaded', () => {
    expect(planReleaseNotesTab(makeState({ status: 'downloading' }), null)?.version).toBe(
      '2026.708.1'
    )
    expect(planReleaseNotesTab(makeState({ status: 'downloaded' }), null)?.version).toBe(
      '2026.708.1'
    )
  })

  it('falls back to the plain-text notes as markdown when no html body is present', () => {
    const plan = planReleaseNotesTab(makeState({ releaseNotesHtml: null }), null)
    expect(plan).toMatchObject({ content: 'New Features\n• A', contentType: 'markdown' })
  })

  it('does not re-open the same version it already surfaced', () => {
    expect(planReleaseNotesTab(makeState(), '2026.708.1')).toBeNull()
  })

  it('returns null for non-surfacing statuses', () => {
    for (const status of ['idle', 'checking', 'up-to-date', 'error', 'installing'] as const) {
      expect(planReleaseNotesTab(makeState({ status }), null)).toBeNull()
    }
  })

  it('returns null when updates are unsupported, no version, or no content', () => {
    expect(planReleaseNotesTab(makeState({ updateSupported: false }), null)).toBeNull()
    expect(planReleaseNotesTab(makeState({ availableVersion: null }), null)).toBeNull()
    expect(
      planReleaseNotesTab(makeState({ releaseNotes: null, releaseNotesHtml: null }), null)
    ).toBeNull()
  })
})
