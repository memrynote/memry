import { describe, expect, it } from 'vitest'
import { toNoteSyncReply } from '../note-sync-reply'

describe('toNoteSyncReply (#2647)', () => {
  it('names the state and gives only the times that exist, as ISO strings', () => {
    expect(
      toNoteSyncReply({
        state: 'sent',
        waitingSince: Date.parse('2026-10-07T09:00:00.000Z'),
        lastSentAt: Date.parse('2026-10-07T09:00:01.000Z'),
        bodyConfirmedAt: null,
        lastFailedAt: null,
        lastRejectedAt: null
      })
    ).toEqual({
      state: 'sent',
      waiting_since: '2026-10-07T09:00:00.000Z',
      last_sent_at: '2026-10-07T09:00:01.000Z'
    })
  })
})
