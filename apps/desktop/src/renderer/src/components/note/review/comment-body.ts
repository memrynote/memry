import type { MentionIconSpec } from '@/agent-chat/mention-icons'
import type { CriticMarkupCommentMentionRef } from '@memry/shared'

export type CommentBodyPart =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; mention: CriticMarkupCommentMentionRef }

export function splitCommentBody(
  body: string,
  mentions: CriticMarkupCommentMentionRef[]
): CommentBodyPart[] {
  const parts: CommentBodyPart[] = []
  const used = new Set<string>()
  let cursor = 0

  while (cursor < body.length) {
    let next: {
      start: number
      end: number
      key: string
      mention: CriticMarkupCommentMentionRef
    } | null = null

    for (const mention of mentions) {
      const key = `${mention.kind}:${mention.refId}`
      if (used.has(key)) continue
      const token = `@${mention.label}`
      const start = body.indexOf(token, cursor)
      if (start === -1) continue
      if (!next || start < next.start) {
        next = { start, end: start + token.length, key, mention }
      }
    }

    if (!next) break
    if (next.start > cursor) parts.push({ kind: 'text', text: body.slice(cursor, next.start) })
    parts.push({ kind: 'mention', mention: next.mention })
    used.add(next.key)
    cursor = next.end
  }

  if (cursor < body.length) parts.push({ kind: 'text', text: body.slice(cursor) })
  return parts
}

export function iconForMention(mention: CriticMarkupCommentMentionRef): MentionIconSpec {
  switch (mention.kind) {
    case 'note':
      return { kind: 'note', emoji: null }
    case 'task':
      return { kind: 'task' }
    case 'journal':
      return { kind: 'journal' }
    case 'inbox':
      return { kind: 'inbox', itemType: null }
    case 'calendar_event':
      return { kind: 'calendar_event' }
  }
}
