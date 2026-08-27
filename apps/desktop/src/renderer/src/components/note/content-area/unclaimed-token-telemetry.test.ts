import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  countUnclaimedTokens,
  reportUnclaimedTokens,
  resetUnclaimedTokenTelemetryForTests
} from './unclaimed-token-telemetry'
import { trackTelemetry } from '@/lib/telemetry'

vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn(async () => {}) }))

const track = vi.mocked(trackTelemetry)

function paragraph(text: string): unknown {
  return { type: 'paragraph', content: [{ type: 'text', text, styles: {} }], children: [] }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetUnclaimedTokenTelemetryForTests()
  track.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('countUnclaimedTokens', () => {
  it('counts literal mention and date tokens left in text runs', () => {
    const blocks = [
      paragraph('still literal ((mention:https%3A%2F%2Fx.com )) here'),
      paragraph('and ((date:broken\\_payload)) plus ((date:another)) here')
    ]

    expect(countUnclaimedTokens(blocks)).toEqual({ mention: 1, date: 2 })
  })

  it('counts an orphaned callout marker only at the head of a paragraph', () => {
    const blocks = [
      paragraph('[!info]'),
      paragraph('mid-sentence [!info] is prose, not a lost marker'),
      { type: 'heading', content: [{ type: 'text', text: '[!info]', styles: {} }], children: [] }
    ]

    expect(countUnclaimedTokens(blocks)).toEqual({ callout_marker: 1 })
  })

  it('counts tokens in string-shaped content, at both the block and the run level', () => {
    const blocks = [
      { type: 'paragraph', content: '[!info] plus ((mention:x))', children: [] },
      { type: 'paragraph', content: ['((date:y))', { type: 'text', text: 'tail', styles: {} }] }
    ]

    expect(countUnclaimedTokens(blocks)).toEqual({ mention: 1, date: 1, callout_marker: 1 })
  })

  it('counts tokens inside table cells and nested children', () => {
    const blocks = [
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [
            {
              cells: [
                {
                  type: 'tableCell',
                  content: [{ type: 'text', text: '((mention:x y))', styles: {} }]
                }
              ]
            }
          ]
        },
        children: []
      },
      {
        type: 'bulletListItem',
        content: [{ type: 'text', text: 'parent', styles: {} }],
        children: [paragraph('((date:child))')]
      }
    ]

    expect(countUnclaimedTokens(blocks)).toEqual({ mention: 1, date: 1 })
  })

  it('ignores tokens inside code blocks and promoted inline nodes', () => {
    const blocks = [
      { type: 'codeBlock', content: [{ type: 'text', text: '((mention:x))', styles: {} }] },
      {
        type: 'paragraph',
        content: [{ type: 'linkMention', props: { url: 'https://x.com' } }],
        children: []
      }
    ]

    expect(countUnclaimedTokens(blocks)).toEqual({})
  })
})

describe('reportUnclaimedTokens', () => {
  it('emits immediately on first sight, once per kind, with the count as a metric', () => {
    reportUnclaimedTokens([paragraph('((mention:a)) and ((mention:b)) and ((date:c))')])

    expect(track).toHaveBeenCalledTimes(2)
    expect(track).toHaveBeenCalledWith(
      'app_error_seen',
      expect.objectContaining({
        action: 'editor_unclaimed_token',
        errorCode: 'unclaimed_mention',
        result: 'failed',
        metrics: { itemCount: 2 }
      })
    )
    expect(track).toHaveBeenCalledWith(
      'app_error_seen',
      expect.objectContaining({ errorCode: 'unclaimed_date', metrics: { itemCount: 1 } })
    )
  })

  it('aggregates a burst into one trailing event per kind instead of spamming', () => {
    reportUnclaimedTokens([paragraph('((mention:a))')])
    track.mockClear()

    for (let i = 0; i < 5; i++) {
      reportUnclaimedTokens([paragraph('((mention:a))')])
    }
    expect(track).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith(
      'app_error_seen',
      expect.objectContaining({ errorCode: 'unclaimed_mention', metrics: { itemCount: 5 } })
    )
  })

  it('emits nothing when every token was claimed', () => {
    reportUnclaimedTokens([paragraph('a healthy note')])

    expect(track).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
