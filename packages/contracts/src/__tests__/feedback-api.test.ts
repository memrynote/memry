import { describe, expect, it } from 'vitest'

import { FEEDBACK_LOGS_MAX_CHARS, FeedbackSubmitSchema } from '../feedback-api'

describe('FeedbackSubmitSchema', () => {
  it('accepts the payload shipped desktop builds send', () => {
    const desktop = {
      message: 'Love the app',
      email: 'user@example.com',
      appVersion: '718.3',
      platform: 'MacIntel'
    }

    expect(FeedbackSubmitSchema.parse(desktop)).toEqual(desktop)
  })

  it('accepts the iOS payload with device facts and logs', () => {
    const ios = {
      message: 'First sync never finishes',
      appVersion: '1.4.0',
      appBuild: '1042',
      platform: 'iOS',
      osVersion: '26.1',
      deviceModel: 'iPhone17,3',
      logs: '2026-11-19T03:47:12.345Z notice sync a first sync started\n'
    }

    expect(FeedbackSubmitSchema.parse(ios)).toEqual(ios)
  })

  it('rejects logs past the cap and an empty log', () => {
    const over = FeedbackSubmitSchema.safeParse({
      message: 'hi',
      logs: 'x'.repeat(FEEDBACK_LOGS_MAX_CHARS + 1)
    })
    const empty = FeedbackSubmitSchema.safeParse({ message: 'hi', logs: '' })

    expect(over.success).toBe(false)
    expect(empty.success).toBe(false)
  })

  it('keeps a full log under the server body limit once JSON-encoded', () => {
    const body = JSON.stringify({ message: 'hi', logs: 'a\n'.repeat(FEEDBACK_LOGS_MAX_CHARS / 2) })

    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(1024 * 1024)
  })
})
