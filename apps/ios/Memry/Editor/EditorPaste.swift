//
//  EditorPaste.swift
//  Plain text pasted into a block becomes the blocks its markdown makes, as
//  desktop's paste reads `text/plain`: a document copied from a chat
//  arrives as headings, lists and bold, not as `#` and `**` in one block.
//

import MemryCore
import UIKit

extension EditorSession {
    /// A paste into `field` of text with more than one line, outside a code
    /// block, whose text stays literal. The core parses it
    /// (`markdownPasteBlockCount`, `NoteEditorViewModel.paste`), and the
    /// caret goes to the end of the last pasted block. One line pastes as
    /// text, as before, and so does text pasted mid-way into a block with
    /// nested blocks, which the core does not split. A selection goes first.
    ///
    /// - Returns: whether it took the paste.
    func pasteMarkdown(_ text: String, in field: BlockField) -> Bool {
        let view = field.textView
        guard let model, field.block.kind != "codeBlock", view.markedTextRange == nil,
              text.contains(where: \.isNewline)
        else { return false }
        let count = Int(markdownPasteBlockCount(markdown: text))
        let selection = view.selectedRange
        let remaining = view.textStorage.length - selection.length
        let inside = selection.location > 0 && selection.location < remaining
        guard count > 0, !(inside && hasNestedBlocks(field.blockId)) else { return false }
        if selection.length > 0 {
            view.textStorage.replaceCharacters(in: selection, with: "")
            view.selectedRange = NSRange(location: selection.location, length: 0)
            field.textViewDidChange(view)
        }
        commit(field)
        let typed = view.textStorage.string
        let caret = min(view.selectedRange.location, view.textStorage.length)
        let blockId = field.blockId
        field.written = enqueue { [weak self] in
            guard let pasted = await model.paste(text, into: blockId, typed: typed, at: caret, count: count) else { return }
            if let step = pasted.step { self?.history.record(step) }
            self?.focus(pasted.lastId)
            await self?.didChange()
        }
        return true
    }
}
