import Foundation
import UIKit

@testable import Memry

extension BlockField {
    /// Types `text` at the caret a key at a time, as the keyboard does.
    func typeKeys(_ text: String) {
        for character in text { press(String(character)) }
    }

    /// Backspace at the caret, as the keyboard presses it.
    func pressBackspace() {
        press("", replacing: NSRange(location: textView.selectedRange.location - 1, length: 1))
    }

    /// One edit from the keyboard, dictation or a paste: UIKit asks the
    /// delegate (`shouldChangeTextIn`), makes the edit, then reports the caret
    /// move and the change. `insertText` called from code skips the question,
    /// and only the question opens an inline menu (`EditorSession.willType`).
    func press(_ text: String, replacing range: NSRange? = nil) {
        let range = range ?? textView.selectedRange
        guard textView(textView, shouldChangeTextIn: range, replacementText: text) else { return }
        textView.textStorage.replaceCharacters(in: range, with: NSAttributedString(string: text, attributes: textView.typingAttributes))
        textView.selectedRange = NSRange(location: range.location + (text as NSString).length, length: 0)
        textViewDidChangeSelection(textView)
        textViewDidChange(textView)
    }
}
