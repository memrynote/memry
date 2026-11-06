import type { FoldLayers, FoldLevel, FoldMorph } from '@memry/contracts/note-fold'
import type {
  FoldLayers as LocalLayers,
  FoldLevel as LocalLevel
} from '../../../../../generated/bindings'

/** The levels this app folds to: the note as written, and its Brief. */
export const LOCAL_FOLD_LEVELS: readonly LocalLevel[] = ['full', 'brief']

const NO_MORPH: FoldMorph = { keyTakeaway: null, keyReason: null, takeaway: null, topic: null }

/** What to ask the fold service for: a level it does not write reads as Brief. */
export function localLevel(level: FoldLevel): LocalLevel {
  return level === 'full' ? 'full' : 'brief'
}

/**
 * The fold service's snapshot as the fold view reads it. The view is written against
 * `@memry/contracts/note-fold`, whose Key, Takeaway and Topic lines a model writes; no model
 * writes here, so those lines are null and no model level is ready.
 */
export function fromLocal(local: LocalLayers): FoldLayers {
  return {
    noteId: local.noteId,
    sourceHash: local.sourceHash,
    language: local.language,
    totalWords: local.totalWords,
    wordsByLevel: { ...local.wordsByLevel, key: 0, takeaway: 0, topic: 0 },
    sections: local.sections.map((section) => ({
      ...section,
      takeaway: null,
      paragraphs: section.paragraphs.map((paragraph) => ({
        ...paragraph,
        morph: NO_MORPH,
        key: null,
        takeaway: null,
        topic: null,
        evidence: []
      }))
    })),
    ready: [],
    status: local.foldable ? 'ready' : 'short',
    agent: null
  }
}
