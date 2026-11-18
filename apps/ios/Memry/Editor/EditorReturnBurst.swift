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
    /// The text view holding the keys: the one Return was pressed in, or the
    /// row a type change redrew for its block (`returnBurstMoved`).
    weak var source: BlockField?
    /// The block Return was pressed in.
    let blockId: String
    /// The source's text before and after the caret when Return was pressed.
    /// Keys typed since sit between the two.
    let head: String
    let tail: String
    /// Whether the source had been typed in (`BlockField.typed`) before the
    /// keys it held, which are not its typing.
    let typed: Bool
    /// The block Return made, once the core holds it.
    var target: String?
    /// The target, or the row a type change redrew for the source's block,
    /// is taking the caret: the source hands over its keys as it resigns.
    var handing = false
    /// The source resigned, and the keys it handed over (`nil`: none).
    var ended = false
    var carried: String?
    /// The core made no block while the keys were carried: the redrawn row
    /// keeps them.
    var refused = false
}

/// The block a Return in a one-line field (the note's title, a journal
/// day's first line) moves the caret to, and the way to take the keys the
/// field held for it meanwhile (`LineReturn`).
struct TitleBurst {
    /// Takes the keys the field held, and the keys its line put back that
    /// the keyboard may still deliver to the block (`LateKeys`). `moved` is
    /// false when the block refused the caret: the field keeps its keys,
    /// stops holding them so its Return works again, and answers neither.
    typealias Take = @MainActor (_ moved: Bool) -> Taken
    typealias Taken = (held: String?, late: LateKeys?)

    let target: String
    let take: Take
}

extension EditorSession {
    /// Return was pressed in `field` and its new block is on its way: keys
    /// typed in `field` from now are held for that block.
    func startReturnBurst(in field: BlockField) {
        let text = field.textView.text as NSString
        let caret = min(field.textView.selectedRange.location, text.length)
        returnBurst = ReturnBurst(
            source: field, blockId: field.blockId, head: text.substring(to: caret), tail: text.substring(from: caret),
            typed: field.typed
        )
    }

    /// The core made `blockId` for the Return in `field`, whose row a type
    /// change may have redrawn since.
    func returnMade(_ blockId: String, from field: BlockField) {
        if returnBurst?.blockId == field.blockId { returnBurst?.target = blockId }
    }

    /// `field` stops holding keys: those it holds stay where they were
    /// typed and commit there, as before #4692. For when the core made no
    /// block, the user edited outside the held keys, or a commit came first.
    /// A held Return stays a line break in the text.
    func keepHeldKeys(in field: BlockField) {
        guard holdsKeys(field) else { return }
        Log.interface.info("keys typed after Return stayed in their block")
        returnBurst = nil
    }

    /// The core made no block for the Return in `field`: the keys typed
    /// after it stay in its block, in the row that holds them now. Keys a
    /// redrawn row has yet to take back stay with the burst until it does.
    func returnRefused(in field: BlockField) {
        guard let burst = returnBurst, burst.blockId == field.blockId else { return }
        guard burst.ended else {
            Log.interface.info("keys typed after Return stayed in their block")
            return returnBurst = nil
        }
        returnBurst?.refused = true
    }

    /// `field`'s keys are held for the block its Return makes.
    func holdsKeys(_ field: BlockField) -> Bool {
        guard let burst = returnBurst else { return false }
        return burst.source === field && !burst.ended
    }

    /// Whether `field`, which holds keys, takes the edit of `range` to
    /// `text`. Among the held keys it does, as typed. An autocorrection
    /// reaching back past the Return would join the two blocks' words
    /// ("Milk⏎eggs" to "Milk eggs"), so it is refused: a replacement that
    /// starts before the held keys, brings text, and is not the user's
    /// selection. Any other edit (Backspace past the Return, typing where an
    /// arrow moved the caret) ends the hold and answers `nil`: it applies
    /// as usual, and the keys stay in `field`.
    func holdsEdit(_ range: NSRange, _ text: String, in field: BlockField) -> Bool? {
        guard let burst = returnBurst else { return nil }
        let view = field.textView
        let head = (burst.head as NSString).length
        let end = (view.text as NSString).length - (burst.tail as NSString).length
        if range.location >= head, NSMaxRange(range) <= end { return true }
        if range.location < head, range.length > 0, !text.isEmpty, range != view.selectedRange { return false }
        keepHeldKeys(in: field)
        return nil
    }

    /// `field` stopped editing, or its row went (`leaving`), before its
    /// typing commits. Handing over, or leaving as a type change redraws
    /// it, it gives up the keys it held; otherwise (the caret went
    /// elsewhere first, the keyboard was hidden) they stay in it and commit
    /// there (#4777).
    func returnBurstEnded(in field: BlockField, leaving: Bool = false) {
        guard let burst = returnBurst, burst.source === field, !burst.ended else { return }
        // A row a type change is redrawing goes, and resigns, before the
        // Return's block takes the caret: its keys go on all the same
        // (REVIEW-4714). Only its leaving says so: resigning, it may be
        // ending the edit, and keys given up then were held only in memory
        // for a row that might never take the caret (#4777).
        guard burst.handing || leaving && shortcutField === field else { return returnBurst = nil }
        // Removing the keys edits the text, and UIKit flushes the keys it
        // queued for the row from inside that edit, as the selection
        // changes (#4769). The burst carries them first, so those keys meet
        // a row that gave up its keys (`carriesEdit`) and act on them in
        // order. No access to the burst may stay open across the edit: one
        // aborts the app.
        let held = heldKeys(burst)
        // Reading the keys ends a composition, which UIKit may flush as
        // held keys; one outside them ends the hold (`holdsEdit`).
        guard returnBurst?.source === field else { return }
        returnBurst?.ended = true
        guard let held else { return }
        returnBurst?.carried = held
        removeHeldKeys(burst, held)
    }

    /// Whether `field`, which gave up its keys as its row went
    /// (`returnBurstEnded`), takes the edit of `range` to `text` into them.
    /// UIKit can still hand it a key before the redrawn row takes the caret:
    /// as it resigns, it gets the keys queued for it. Typed into its text,
    /// such a key came out after the carried keys but ahead of the caret,
    /// so the next keys landed before it (`milk⏎eggs⏎` stored as
    /// `milk|egs|g`, #4737). A key typed at the caret joins the carried
    /// keys, and a Backspace takes back the last of them. Any other text
    /// (an autocorrection) is refused.
    func carriesEdit(_ range: NSRange, _ text: String, in field: BlockField) -> Bool {
        guard let burst = returnBurst, burst.source === field, burst.ended,
              field.textView.text == burst.head + burst.tail
        else { return false }
        let head = (burst.head as NSString).length
        if range == NSRange(location: head, length: 0), !text.isEmpty {
            returnBurst?.carried = (burst.carried ?? "") + text
            return true
        }
        if !text.isEmpty { return true }
        guard range.length > 0, NSMaxRange(range) == head, var carried = burst.carried else { return false }
        carried.removeLast()
        returnBurst?.carried = carried.isEmpty ? nil : carried
        return true
    }

    /// `field`, the row a type change redrew, took the caret from the row
    /// Return was pressed in: it holds the keys that row gave up, and those
    /// typed from now, until the Return's block takes the caret
    /// (REVIEW-4714 M3).
    func returnBurstMoved(to field: BlockField) {
        guard let burst = returnBurst, burst.blockId == field.blockId, burst.ended else { return }
        if let carried = burst.carried {
            let view = field.textView
            let head = min((burst.head as NSString).length, view.textStorage.length)
            view.textStorage.replaceCharacters(
                in: NSRange(location: head, length: 0),
                with: NSAttributedString(string: carried, attributes: BlockText.baseAttributes(field.style))
            )
            view.selectedRange = NSRange(location: head + (carried as NSString).length, length: 0)
            field.dirty = view.text != field.base
        }
        if burst.refused {
            Log.interface.error("keys typed after Return went back to their redrawn block")
            return returnBurst = nil
        }
        returnBurst?.source = field
        returnBurst?.ended = false
        returnBurst?.carried = nil
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
        let fromTitle = titleBurst?.target == field.blockId
        let textView = field.textView
        // A row drawn but not yet in the window cannot take the caret: the
        // keys stay held until it moves in (`field(_:movedInto:)`).
        if takesCaretOnArrival(field) { return pendingFocus = field.blockId }
        // A redrawn row can take the caret before the old row goes: the old
        // row then resigns without leaving, and hands its keys on all the
        // same (`returnBurstMoved`, #4777). Only the row redrawn for its
        // own block: another block's row would never take them back
        // (REVIEW-4790 M1).
        let redraw = redraws(field)
        if handing || redraw && returnBurst?.source === shortcutField { returnBurst?.handing = true }
        let took = textView.becomeFirstResponder()
        if redraw { returnBurst?.handing = false }
        if atEnd { textView.selectedRange = NSRange(location: textView.textStorage.length, length: 0) }
        // The old row may have left already, so nothing else holds the caret.
        if !took, redraw {
            Log.interface.error("the row a type change redrew did not take the caret")
            pendingFocus = field.blockId
        }
        if fromTitle, let burst = titleBurst {
            titleBurst = nil
            // The field kept the caret, so its keys stay with it.
            let (held, late) = burst.take(took)
            if let held {
                type(held, into: field)
                if !textView.isFirstResponder, field.dirty { commit(field) }
            }
            lateKeys = late.map { (field.blockId, $0) }
            return
        }
        guard handing, let burst = returnBurst else { return }
        returnBurst = nil
        // The source kept the caret, so the next keys go on landing there:
        // the held ones stay with them, in order.
        if !took, !burst.ended {
            Log.interface.error("the block a Return made did not take the caret")
            return
        }
        // A source that was not editing never resigned: its keys come now.
        let held = burst.ended ? burst.carried : heldKeys(burst)
        guard let held else { return }
        if !burst.ended { removeHeldKeys(burst, held) }
        type(held, into: field)
        // Typing commits as editing ends, which never began here.
        if !textView.isFirstResponder, field.dirty { commit(field) }
    }

    /// Whether `text`, about to be typed into `field`, is only keys the
    /// title's Return put back in its line that the keyboard delivered
    /// after all: they are dropped (`LateKeys`). Any other edit, in any
    /// block, ends the wait for them.
    func dropsLateKeys(_ text: String, in field: BlockField) -> Bool {
        guard var late = lateKeys else { return false }
        lateKeys = nil
        guard late.blockId == field.blockId, !text.isEmpty, text.allSatisfy({ late.keys.arrived($0) }) else { return false }
        if late.keys.waiting { lateKeys = late }
        return true
    }

    /// A hardware key went down in `field`: a key it types later is that
    /// key, not a late one.
    func keyWentDown(_ characters: String, in field: BlockField) {
        guard lateKeys?.blockId == field.blockId else { return }
        lateKeys?.keys.pressed(characters)
    }

    /// `field` is not in a window yet, and takes the caret as it moves in
    /// (`field(_:movedInto:)`), in the turn the row it takes over from may
    /// leave: so no key arrives while no text view holds the caret. It is
    /// the block a Return made, the block a one-line field's Return moves
    /// to, or a row a type change redrew.
    func takesCaretOnArrival(_ field: BlockField) -> Bool {
        guard field.textView.window == nil else { return false }
        let handing = returnBurst.map { $0.target == field.blockId && $0.source !== field } ?? false
        return handing || titleBurst?.target == field.blockId || redraws(field)
    }

    /// `field` is the new row of a block a type change is redrawing.
    private func redraws(_ field: BlockField) -> Bool {
        shortcutField.map { $0.blockId == field.blockId && $0 !== field } ?? false
    }

    /// The keys held for the burst's target in the block they were typed
    /// in. A composition still open there ends as it stands, so its text
    /// moves too.
    private func heldKeys(_ burst: ReturnBurst) -> String? {
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
        // An attachment (a paste) has no text to type again in the new
        // block: the keys stay with it.
        guard !held.contains(BlockText.placeholder) else {
            Log.interface.error("keys typed after Return held an attachment and stayed in their block")
            return nil
        }
        return held
    }

    /// Takes `held`, read by `heldKeys`, out of the block they were typed in.
    private func removeHeldKeys(_ burst: ReturnBurst, _ held: String) {
        guard let source = burst.source else { return }
        let view = source.textView
        let head = (burst.head as NSString).length
        view.textStorage.replaceCharacters(in: NSRange(location: head, length: (held as NSString).length), with: "")
        view.selectedRange = NSRange(location: head, length: 0)
        view.forgetTyping()
        source.dirty = view.text != source.base
        source.typed = burst.typed
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
