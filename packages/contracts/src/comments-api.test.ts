import { describe, expect, it } from 'vitest'

import { CommentSchema, CreateCommentInputSchema, UpdateCommentInputSchema } from './comments-api'

const mentionRefs = [
  { kind: 'note', refId: 'note-1', label: 'Launch notes' },
  { kind: 'calendar_event', refId: 'event-1', label: 'Planning sync' }
] as const

describe('comments api schemas', () => {
  it('accepts mentionRefs on create and defaults to no mentions', () => {
    const withMentions = CreateCommentInputSchema.parse({
      targetType: 'note',
      targetId: 'note-1',
      selectedQuote: 'selected text',
      mentionRefs
    })

    expect(withMentions.mentionRefs).toEqual(mentionRefs)

    const withoutMentions = CreateCommentInputSchema.parse({
      targetType: 'journal',
      targetId: '2026-05-22',
      selectedQuote: 'today'
    })

    expect(withoutMentions.mentionRefs).toEqual([])
  })

  it('round-trips mentionRefs through comment and update schemas', () => {
    const comment = CommentSchema.parse({
      id: 'comment-1',
      targetType: 'note',
      targetId: 'note-1',
      selectedQuote: 'selected text',
      blockId: null,
      rangeStart: 0,
      rangeEnd: 13,
      prefix: null,
      suffix: null,
      body: 'See @Launch notes',
      mentionRefs,
      attachmentRefs: ['memry://attachment/image.png'],
      status: 'open',
      clock: null,
      syncedAt: null,
      createdAt: '2026-05-22T00:00:00.000Z',
      modifiedAt: '2026-05-22T00:00:00.000Z'
    })

    expect(comment.mentionRefs).toEqual(mentionRefs)

    const update = UpdateCommentInputSchema.parse({
      id: 'comment-1',
      mentionRefs: [{ kind: 'task', refId: 'task-1', label: 'Ship inline comments' }]
    })

    expect(update.mentionRefs).toEqual([
      { kind: 'task', refId: 'task-1', label: 'Ship inline comments' }
    ])
  })

  it('rejects invalid mentionRefs', () => {
    expect(
      CreateCommentInputSchema.safeParse({
        targetType: 'note',
        targetId: 'note-1',
        selectedQuote: 'selected text',
        mentionRefs: [{ kind: 'unknown', refId: 'x', label: 'Broken' }]
      }).success
    ).toBe(false)

    expect(
      CreateCommentInputSchema.safeParse({
        targetType: 'note',
        targetId: 'note-1',
        selectedQuote: 'selected text',
        mentionRefs: [{ kind: 'note', refId: '', label: 'Broken' }]
      }).success
    ).toBe(false)
  })
})
