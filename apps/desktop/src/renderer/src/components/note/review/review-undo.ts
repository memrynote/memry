import { serializeCriticMarkup, type CriticMarkupMark } from '@memry/shared'

export interface ReviewUndoSnapshot {
  plainMarkdown: string
  marks: CriticMarkupMark[]
}

export interface ReviewUndoEntry {
  before: ReviewUndoSnapshot
  afterSerialized: string
  // Suggestion mark id for live-suggestion edits: consecutive keystrokes on
  // the same mark coalesce into one undo step (whole-suggestion granularity).
  coalesceKey?: string
}

export function snapshotReviewState(
  plainMarkdown: string,
  marks: CriticMarkupMark[]
): ReviewUndoSnapshot {
  return {
    plainMarkdown,
    marks: marks.map((mark) => ({ ...mark }))
  }
}

export function pushReviewUndoEntry(
  stack: ReviewUndoEntry[],
  before: ReviewUndoSnapshot,
  afterPlainMarkdown: string,
  afterMarks: CriticMarkupMark[],
  coalesceKey?: string
): void {
  const afterSerialized = serializeCriticMarkup(afterPlainMarkdown, afterMarks)
  const top = stack.at(-1)
  if (coalesceKey !== undefined && top?.coalesceKey === coalesceKey) {
    // Same suggestion run: keep the original `before`, only advance `after`.
    top.afterSerialized = afterSerialized
    return
  }
  stack.push({
    before,
    afterSerialized,
    ...(coalesceKey !== undefined ? { coalesceKey } : {})
  })
  if (stack.length > 50) stack.splice(0, stack.length - 50)
}

export function isUndoKeyboardShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== 'z') return false
  if (event.altKey || event.shiftKey) return false
  return event.metaKey || event.ctrlKey
}

export function isRedoKeyboardShortcut(event: KeyboardEvent): boolean {
  if (event.altKey) return false
  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey && (event.metaKey || event.ctrlKey)
  if (key === 'y') return event.ctrlKey && !event.metaKey && !event.shiftKey
  return false
}

export function isNativeTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select'))
}
