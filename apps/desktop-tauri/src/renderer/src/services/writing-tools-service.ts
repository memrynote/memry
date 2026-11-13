import { commands } from '../../../generated/bindings'
import { createLogger } from '../lib/logger'
import { wordAtPoint } from '../lib/word-at-point'
import type {
  EditorContextMenuSpelling,
  WritingAssistInput,
  WritingAssistResult
} from '@memry/contracts/writing-tools-api'

const log = createLogger('WritingTools')

export async function spellingFor(word: string): Promise<EditorContextMenuSpelling | null> {
  try {
    const result = await commands.spellCheckWord(word)
    return result.available && result.misspelled
      ? { misspelledWord: word, dictionarySuggestions: result.suggestions }
      : null
  } catch (error) {
    log.warn('spell check failed', error)
    return null
  }
}

export const writingToolsService = {
  /** Rejects with the command's (localized) error when the request fails. */
  generateAssist(input: WritingAssistInput): Promise<WritingAssistResult> {
    return commands.writingGenerateAssist(input)
  },
  /**
   * The word under the pointer when it is misspelled, with the platform's suggestions. Null when
   * the point is not on a word, the word is fine, or the platform has no dictionary.
   */
  async spellingAt(x: number, y: number): Promise<EditorContextMenuSpelling | null> {
    const hit = wordAtPoint(x, y)
    return hit ? spellingFor(hit.word) : null
  },
  addWordToDictionary(word: string): Promise<boolean> {
    return commands.spellAddWord(word)
  }
}
