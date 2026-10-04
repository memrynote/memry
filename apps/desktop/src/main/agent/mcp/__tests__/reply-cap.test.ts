import { describe, expect, it } from 'vitest'

import { capReply } from '../reply-cap'

type CutReply = { truncated: boolean; totalBytes: number; message: string; partial: string }

const notice = (kept: number, total: number) =>
  `Reply cut at ${kept} of ${total} bytes. partial holds the start of the JSON reply and is not valid JSON on its own. The rest is not returned. Call an operation that returns less, such as a list with a smaller limit, or vault_read_note for a note body.`

describe('capReply', () => {
  it('returns a reply within the limit unchanged', () => {
    const reply = { id: 'note-1', content: 'Short body' }

    expect(capReply(reply, 102_400)).toEqual({ id: 'note-1', content: 'Short body' })
  })

  it('cuts a reply so that it stays within the limit after escaping and says so', () => {
    const value = { id: 'note-1', content: '"'.repeat(150_000) }
    const reply = capReply(value, 102_400) as CutReply
    const replyBytes = Buffer.byteLength(JSON.stringify(reply))

    expect(reply.truncated).toBe(true)
    expect(reply.totalBytes).toBe(300_028)
    expect(replyBytes).toBeLessThanOrEqual(102_400)
    expect(replyBytes).toBeGreaterThan(101_000)
    expect(reply.message).toBe(notice(Buffer.byteLength(reply.partial), 300_028))
    expect(JSON.stringify(value).startsWith(reply.partial)).toBe(true)
  })

  it('measures the limit in UTF-8 bytes and cuts on a character boundary', () => {
    const value = { id: 'note-1', content: '\u6f22\u{1F600}'.repeat(20_000) }
    const reply = capReply(value, 102_400) as CutReply
    const replyBytes = Buffer.byteLength(JSON.stringify(reply))

    expect(JSON.stringify(value).length).toBeLessThan(102_400)
    expect(reply.truncated).toBe(true)
    expect(reply.totalBytes).toBe(140_028)
    expect(replyBytes).toBeLessThanOrEqual(102_400)
    expect(replyBytes).toBeGreaterThan(101_000)
    expect(/[\uD800-\uDBFF]$/.test(reply.partial)).toBe(false)
    expect(JSON.stringify(value).startsWith(reply.partial)).toBe(true)
  })
})
