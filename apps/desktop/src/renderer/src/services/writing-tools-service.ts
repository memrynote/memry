import type {
  EditorContextMenuSpelling,
  WritingAssistInput,
  WritingAssistResult
} from '@memry/contracts/writing-tools-api'

export const writingToolsService = {
  /** Throws with main's (localized) message when the request fails. */
  async generateAssist(input: WritingAssistInput): Promise<WritingAssistResult> {
    const response = await window.api.writingTools.generateAssist(input)
    if (!response.success) throw new Error(response.error)
    return response.result
  },
  /**
   * Claim this window's next native `context-menu` event for the note editor.
   * False when the bridge is not there (tests, older preload), in which case
   * no spelling data will arrive.
   */
  claimEditorContextMenu(): boolean {
    return window.api?.writingTools?.claimEditorContextMenu?.() === true
  },
  onEditorContextMenu(callback: (spelling: EditorContextMenuSpelling) => void): () => void {
    return window.api?.onEditorContextMenu?.(callback) ?? (() => {})
  },
  addWordToDictionary(word: string): Promise<boolean> {
    return window.api.writingTools.addWordToDictionary(word)
  }
}
