import type { CommentMentionKind, CommentMentionRef } from '@/services/comments-service'
interface MentionRefSource {
  kind: string
  ref_id: string
  label: string
}

export interface ActiveMentionQuery {
  start: number
  end: number
  query: string
}

const allowedMentionKinds = new Set<CommentMentionKind>([
  'note',
  'journal',
  'task',
  'inbox',
  'calendar_event',
  'project',
  'folder'
])

export function findActiveMentionQuery(value: string, caret: number): ActiveMentionQuery | null {
  const beforeCaret = value.slice(0, caret)
  const match = /(^|\s)@([^\s@]*)$/.exec(beforeCaret)
  if (!match) return null
  const atIndex = beforeCaret.lastIndexOf('@')
  if (atIndex < 0) return null
  return { start: atIndex, end: caret, query: match[2] ?? '' }
}

export function toMentionRef(attachment: MentionRefSource): CommentMentionRef | null {
  const kind = attachment.kind as CommentMentionKind
  if (!allowedMentionKinds.has(kind)) return null
  return { kind, refId: attachment.ref_id, label: attachment.label }
}

export function dedupeMentionRefs(mentions: CommentMentionRef[]): CommentMentionRef[] {
  const seen = new Set<string>()
  return mentions.filter((mention) => {
    const key = `${mention.kind}:${mention.refId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
