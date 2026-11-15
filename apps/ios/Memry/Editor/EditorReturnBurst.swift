//
//  EditorReturnBurst.swift
//  #4692: keys typed right after Return go into the block Return made.
//
//  Return writes the new block through the core and the page draws its row
//  on a later turn, so the caret stays in the old block for a moment. A fast
//  typist, a text expander or a hardware burst types into it meanwhile, and
//  the old block saved those keys while the new one stayed empty (DATA-LOSS:
//  text in the wrong block). The old block now takes such keys as plain
//  text, Returns included, at the caret, and hands them to the new block as
//  it takes the caret, which types them again in order there.
//

import UIKit

/// The block Return was pressed in, until the block it made takes the caret.
struct ReturnBurst {
    weak var source: BlockField?
    /// The source's text before and after the caret when Return was pressed.
    /// Keys typed since sit between the two.
    let head: String
    let tail: String
    /// Whether the source had been typed in (`BlockField.typed`) before the
    /// keys it held, which are not its typing.
    let typed: Bool
    /// The block Return made, once the core holds it.
    var target: String?
    /// The target is taking the caret: the source hands over its keys as it
    /// resigns.
    var handing = false
    /// The source resigned, and the keys it handed over (`nil`: none).
    var ended = false
    var carried: String?
}

extension EditorSession {
    /// Return was pressed in `field` and its new block is on its way: keys
    /// typed in `field` from now are held for that block.
    func startReturnBurst(in field: BlockField) {
        let text = field.textView.text as NSString
        let caret = min(field.textView.selectedRange.location, text.length)
        returnBurst = ReturnBurst(
            source: field, head: text.substring(to: caret), tail: text.substring(from: caret), typed: field.typed
        )
    }

    /// The core made `blockId` for the Return in `field`.
    func returnMade(_ blockId: String, from field: BlockField) {
        if returnBurst?.source === field { returnBurst?.target = blockId }
    }

    /// The core made no block for the Return in `field`: its keys stay where
    /// they were typed.
    func dropReturnBurst(from field: BlockField) {
        if returnBurst?.source === field { returnBurst = nil }
    }

    /// `field`'s keys are held for the block its Return makes.
    func holdsKeys(_ field: BlockField) -> Bool {
        guard let burst = returnBurst else { return false }
        return burst.source === field && !burst.ended
    }

    /// Whether `range` in `field`'s text lies among the keys it holds. An
    /// autocorrection reaching back past the Return would join the two
    /// blocks' words ("Milkeggs" to "Milk eggs"), so it is refused.
    func holdsRange(_ range: NSRange, in field: BlockField) -> Bool {
        guard let burst = returnBurst else { return false }
        let length = (field.textView.text as NSString).length
        return range.location >= (burst.head as NSString).length
            && NSMaxRange(range) <= length - (burst.tail as NSString).length
    }

    /// `field` stopped editing, before its typing commits. Handing over, it
    /// gives up the keys it held; otherwise (the caret went elsewhere first)
    /// they stay in it and commit there.
    func returnBurstEnded(in field: BlockField) {
        guard let burst = returnBurst, burst.source === field else { return }
        guard burst.handing else { return returnBurst = nil }
        returnBurst?.carried = takeHeldKeys(burst)
        returnBurst?.ended = true
    }

    /// Puts the caret in `field`, at its end unless `atEnd` is false, and
    /// types there the keys its Return's old block held for it. Every move
    /// of the caret into a drawn block comes here.
    ///
    /// The old block gives up its keys as it resigns, inside
    /// `becomeFirstResponder`: UIKit first hands it the keys it has queued
    /// for it, so taking them any earlier misses those.
    func takeCaret(_ field: BlockField, atEnd: Bool = true) {
        let handing = returnBurst.map { $0.target == field.blockId && $0.source !== field } ?? false
        let textView = field.textView
        // A row drawn but not yet in the window cannot take the caret: the
        // keys stay held until it moves in (`field(_:movedInto:)`).
        if handing, textView.window == nil { return pendingFocus = field.blockId }
        if handing { returnBurst?.handing = true }
        textView.becomeFirstResponder()
        if atEnd { textView.selectedRange = NSRange(location: textView.textStorage.length, length: 0) }
        guard handing, let burst = returnBurst else { return }
        returnBurst = nil
        // A source that was not editing never resigned: its keys come now.
        let held = burst.ended ? burst.carried : takeHeldKeys(burst)
        guard let held else { return }
        type(held, into: field)
        // Typing commits as editing ends, which never began here.
        if !textView.isFirstResponder, field.dirty { commit(field) }
    }

    /// Takes the keys held for the burst's target out of the block they were
    /// typed in. A composition still open there ends as it stands, so its
    /// text moves too.
    private func takeHeldKeys(_ burst: ReturnBurst) -> String? {
        guard let source = burst.source else { return nil }
        let view = source.textView
        if view.markedTextRange != nil { view.unmarkText() }
        let text = view.text as NSString
        let head = (burst.head as NSString).length
        let tail = (burst.tail as NSString).length
        // Only keys typed at the caret move: anything else (a deletion into
        // the old text, a moved caret) leaves them where they are, as before.
        guard text.length >= head + tail, text.substring(to: head) == burst.head,
              text.substring(from: text.length - tail) == burst.tail
        else {
            Log.interface.error("keys typed after Return stayed in their block")
            return nil
        }
        let range = NSRange(location: head, length: text.length - head - tail)
        guard range.length > 0 else { return nil }
        let held = text.substring(with: range)
        view.textStorage.replaceCharacters(in: range, with: "")
        view.selectedRange = NSRange(location: head, length: 0)
        view.forgetTyping()
        // A commit while the keys were held (a typed link) wrote them to the
        // old block: its resign then writes them back out.
        source.dirty = view.text != source.base
        source.typed = burst.typed
        return held
    }

    /// Types `text` into `field` a key at a time, as the keyboard does. A
    /// Return among them makes its block as any Return does, and the rest
    /// waits in `field` for that block.
    private func type(_ text: String, into field: BlockField) {
        let view = field.textView
        var rest = Substring(text)
        while let key = rest.first {
            if holdsKeys(field) {
                view.insertText(String(rest))
                field.textViewDidChange(view)
                return
            }
            rest = rest.dropFirst()
            let typed = String(key)
            if view.delegate?.textView?(view, shouldChangeTextIn: view.selectedRange, replacementText: typed) != false {
                view.insertText(typed)
            }
        }
    }
}
