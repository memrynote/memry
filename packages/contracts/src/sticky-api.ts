import { z } from 'zod'

import { StickyChannels } from './ipc-channels'
export { StickyChannels }

/**
 * Where the sticky sends its text: a note in the vault's Sticky folder, a task,
 * or a paragraph appended to today's journal entry.
 *
 * Persisted in synced `sticky_draft` records (chapter 13), so the set only
 * grows. A reader that meets a kind it does not know treats it as `note`.
 */
export const STICKY_KINDS = ['note', 'task', 'journal'] as const
export type StickyKind = (typeof STICKY_KINDS)[number]

export function parseStickyKind(value: unknown): StickyKind {
  return typeof value === 'string' && (STICKY_KINDS as readonly string[]).includes(value)
    ? (value as StickyKind)
    : 'note'
}

/**
 * Unsent sticky text. Esc and clicking away keep it; only sending it or an
 * explicit delete removes it. Drafts sync across devices.
 */
export interface StickyDraft {
  id: string
  content: string
  kind: StickyKind
  createdAt: string
  modifiedAt: string
}

export const StickySaveDraftSchema = z.object({
  /** Omit to start a new draft. */
  id: z.string().min(1).optional(),
  content: z.string().max(100_000),
  kind: z.enum(STICKY_KINDS)
})
export type StickySaveDraftInput = z.infer<typeof StickySaveDraftSchema>

export const StickyDraftIdSchema = z.object({ id: z.string().min(1) })
export type StickyDraftIdInput = z.infer<typeof StickyDraftIdSchema>

export const StickySendSchema = z.object({
  /** The draft the text came from; deleted once the send lands. */
  draftId: z.string().min(1).nullable(),
  content: z.string().min(1).max(100_000),
  kind: z.enum(STICKY_KINDS)
})
export type StickySendInput = z.infer<typeof StickySendSchema>

/**
 * What a send created. `targetId` is a note id, a task id, or the journal
 * date (`YYYY-MM-DD`). `undoToken` is null for journal sends, which have no
 * undo: the appended text merges into a synced document.
 */
export type StickySendResult =
  | {
      success: true
      kind: StickyKind
      targetId: string
      title: string
      undoToken: string | null
    }
  | { success: false; error: string }

export const StickyUndoSchema = z.object({ undoToken: z.string().min(1) })
export type StickyUndoInput = z.infer<typeof StickyUndoSchema>

export type StickyUndoResult =
  { success: true; draft: StickyDraft } | { success: false; error: string }

export const StickyOpenTargetSchema = z.object({
  kind: z.enum(STICKY_KINDS),
  targetId: z.string().min(1)
})
export type StickyOpenTargetInput = z.infer<typeof StickyOpenTargetSchema>

/** Which draft the sticky window shows when it opens. Null starts a blank sticky. */
export interface StickyWindowSession {
  draftId: string | null
}

export const StickyUnfoldSchema = z.object({ draftId: z.string().min(1).nullable() })
export type StickyUnfoldInput = z.infer<typeof StickyUnfoldSchema>

export const StickyPeekSchema = z.object({ open: z.boolean() })
export type StickyPeekInput = z.infer<typeof StickyPeekSchema>

export const StickyResizeSchema = z.object({ height: z.number().finite().positive() })
export type StickyResizeInput = z.infer<typeof StickyResizeSchema>
