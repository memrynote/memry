/**
 * `note-fold.json`: what `fold-service.ts` `get` does before any model is
 * asked (language, inline tokens, the fold threshold, sections and chunks,
 * `assemble` with no model lines), for each document of `doc-cases.ts`.
 * `levels` lists the levels the file covers; the model levels (Key, Takeaway,
 * Topic) are in `note-fold-model.json` (`model.ts`). Checked by
 * `crates/memry-desktop/tests/note_fold_vectors.rs`.
 */
import {
  assemble,
  buildSections,
  detectLanguage,
  isFoldable
} from '../../src/main/note-fold/engine'
import { expandInlineTokens, withoutInlineTokens } from '../../src/main/note-fold/engine-tokens'

import { NOTE_FOLD_CASES } from './doc-cases'

function foldCase(markdown: string): Record<string, unknown> {
  const language = detectLanguage(withoutInlineTokens(markdown))
  const source = expandInlineTokens(markdown, language)
  const sections = isFoldable(source, language) ? buildSections(source, language) : []
  const { layers } = assemble({
    noteId: 'note',
    source,
    language,
    sections,
    lookup: () => undefined
  })
  return {
    language,
    source,
    sourceHash: layers.sourceHash,
    foldable: sections.length > 0,
    totalWords: layers.totalWords,
    wordsByLevel: { full: layers.wordsByLevel.full, brief: layers.wordsByLevel.brief },
    sections: layers.sections.map((section, i) => ({
      hash: section.hash,
      heading: section.heading,
      skipped: section.skipped,
      chunks: sections[i].chunks.map((chunk) => chunk.hash),
      paragraphs: section.paragraphs.map((p) => ({
        hash: p.hash,
        text: p.text,
        sentences: p.sentences,
        sentencesMd: p.sentencesMd,
        srcTokens: p.srcTokens,
        srcSentenceStart: p.srcSentenceStart,
        briefIdx: p.briefIdx
      }))
    }))
  }
}

export function buildDoc(): Record<string, unknown> {
  return {
    levels: ['full', 'brief'],
    cases: NOTE_FOLD_CASES.map((c) => ({
      name: c.name,
      written: c.written,
      markdown: c.markdown,
      expected: foldCase(c.markdown)
    }))
  }
}
