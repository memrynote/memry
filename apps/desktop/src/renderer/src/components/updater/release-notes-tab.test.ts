import { describe, expect, it } from 'vitest'
import type { WhatsNewPayload } from '@memry/contracts/ipc-updater'
import { planReleaseNotesTab } from './release-notes-tab'

function makePayload(overrides: Partial<WhatsNewPayload> = {}): WhatsNewPayload {
  return {
    version: '2026.708.1',
    content: '<h2>New Features</h2><ul><li>A</li></ul>',
    contentType: 'html',
    ...overrides
  }
}

describe('planReleaseNotesTab', () => {
  it('plans a tab titled "MemryNote <version>" from the consumed whats-new payload', () => {
    expect(planReleaseNotesTab(makePayload())).toEqual({
      version: '2026.708.1',
      title: 'MemryNote 2026.708.1',
      content: '<h2>New Features</h2><ul><li>A</li></ul>',
      contentType: 'html'
    })
  })

  it('passes markdown content through with its content type', () => {
    expect(
      planReleaseNotesTab(makePayload({ content: 'New\n• A', contentType: 'markdown' }))
    ).toMatchObject({ content: 'New\n• A', contentType: 'markdown' })
  })

  it('returns null when there is nothing to show', () => {
    expect(planReleaseNotesTab(null)).toBeNull()
    expect(planReleaseNotesTab(makePayload({ content: '' }))).toBeNull()
  })
})
