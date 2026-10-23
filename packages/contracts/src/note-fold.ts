import { z } from 'zod'

/**
 * Note folding (TextFold-style levels). One owner: the main-process fold
 * service builds a `FoldLayers` snapshot per note from its Markdown body and
 * the renderer only displays it. Generation never runs on zoom.
 */

export const FOLD_LEVELS = ['full', 'brief', 'key', 'takeaway', 'topic'] as const
export const FoldLevelSchema = z.enum(FOLD_LEVELS)
export type FoldLevel = z.infer<typeof FoldLevelSchema>

/** Levels a model writes. Brief is verbatim source sentences, so it is local-capable. */
export const AI_FOLD_LEVELS = ['key', 'takeaway', 'topic'] as const
export type AiFoldLevel = (typeof AI_FOLD_LEVELS)[number]

/** Notes at or under this many words are never folded or sent to a model. */
export const FOLD_MIN_WORDS = 150

export const FoldParagraphSchema = z
  .object({
    /** sha256 of the normalized paragraph text; stable across edits elsewhere. */
    hash: z.string().min(1),
    text: z.string(),
    /** Source sentences, in order (Intl.Segmenter by note language). */
    sentences: z.array(z.string()),
    /** Indices into `sentences` that make Brief; always present (local pick when no model). */
    briefIdx: z.array(z.number().int().nonnegative()),
    /** null until the model has written it. */
    key: z.object({ takeaway: z.string(), reason: z.string() }).nullable(),
    takeaway: z.string().nullable(),
    topic: z.string().nullable(),
    /** Sentence indices the AI lines rest on (hover underline). */
    evidence: z.array(z.number().int().nonnegative())
  })
  .strict()
export type FoldParagraph = z.infer<typeof FoldParagraphSchema>

export const FoldSectionSchema = z
  .object({
    hash: z.string().min(1),
    heading: z.string().nullable(),
    takeaway: z.string().nullable(),
    paragraphs: z.array(FoldParagraphSchema)
  })
  .strict()
export type FoldSection = z.infer<typeof FoldSectionSchema>

export const FoldLayersSchema = z
  .object({
    noteId: z.string(),
    /** sha256 of the whole source text this snapshot was built from. */
    sourceHash: z.string(),
    language: z.string(),
    totalWords: z.number().int().nonnegative(),
    wordsByLevel: z.record(FoldLevelSchema, z.number().int().nonnegative()),
    sections: z.array(FoldSectionSchema),
    /** Levels fully written by the model for the current text. */
    ready: z.array(FoldLevelSchema),
    /** What the settings row shows. */
    status: z.enum(['off', 'short', 'no_agent', 'writing', 'ready', 'failed']),
    /** Agent label for "Written by <agent>"; null when none. */
    agent: z.string().nullable()
  })
  .strict()
export type FoldLayers = z.infer<typeof FoldLayersSchema>

export const FoldGetRequestSchema = z.object({ noteId: z.string().min(1) }).strict()
/** No `noteId` retries the last failed note. */
export const FoldRetryRequestSchema = z.object({ noteId: z.string().min(1).optional() }).strict()

/** Global state of the most recent model run, for the Settings row. */
export const FoldLastRunSchema = z
  .object({
    status: z.enum(['idle', 'writing', 'failed']),
    noteId: z.string().nullable()
  })
  .strict()
export type FoldLastRun = z.infer<typeof FoldLastRunSchema>

export const FoldChannels = {
  invoke: {
    /** Returns the current snapshot (local fallback at once) and queues missing AI work. */
    GET: 'note-fold:get',
    /** Re-queue after a failed run. */
    RETRY: 'note-fold:retry',
    /** Global last-run status (idle / writing / failed + the note it concerns). */
    LAST_RUN: 'note-fold:last-run'
  },
  events: {
    /** Payload: { noteId } — renderer refetches via GET. */
    UPDATED: 'note-fold:updated'
  }
} as const
