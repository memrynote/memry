//
//  NewNoteKeys.swift
//  #4787: keys typed right after ⌘N go into the new note's title.
//
//  ⌘N writes the new note through the core, and its page draws on a later
//  turn, so the caret stays in the open note's body meanwhile. A typist
//  keeps going, and those keys landed in the note they had left, or went
//  nowhere once that page left the window (iPad HID at high load: 30 of 30
//  runs lost them, 5 into the old note). From ⌘N on, a hidden text view
//  holds the keys. The body resigns as it would for any other field, so its
//  own typing commits. The first text input to begin editing after it,
//  which is the new title taking the caret, gets the held keys typed in, in
//  order and ahead of any later key. When the hold ends with no text input
//  taking the caret, the keys become the new note's title, so none is
//  dropped.
//

import UIKit

/// One ⌘N's keys, held until its note's title takes the caret.
@MainActor
final class NewNoteKeys {
    /// Writes held keys as `noteId`'s title.
    typealias Keep = @MainActor (_ noteId: String, _ text: String) -> Void

    private var holder: KeyHolder?
    private var keep: Keep?
    /// The new note, once the core holds it.
    private var noteId: String?
    /// The holder lost the caret with no text input taking it.
    private var resigned = false
    /// The holder is resigning: a text input that begins editing in this
    /// turn is the one taking the caret.
    private var handing = false
    private var observers: [NSObjectProtocol] = []

    /// ⌘N: holds the keys typed from now on in `window`. The holder keeps
    /// this hold alive until the keys are handed on.
    init(window: UIWindow?, keep: @escaping Keep) {
        guard let window else { return }
        let holder = KeyHolder(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        holder.hold = self
        window.addSubview(holder)
        self.holder = holder
        self.keep = keep
        for name in [UITextView.textDidBeginEditingNotification, UITextField.textDidBeginEditingNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] note in
                let input = note.object as? UIKeyInput
                MainActor.assumeIsolated { self?.began(input) }
            })
        }
        holder.becomeFirstResponder()
    }

    /// The core made the note the keys are held for.
    func made(_ noteId: String) {
        guard holder != nil else { return }
        self.noteId = noteId
        if resigned { end() }
    }

    /// The core made no note: the failure is on screen, and the hold ends.
    func failed() {
        noteId = nil
        end()
    }

    fileprivate func holderResigned() {
        guard holder != nil else { return }
        // A text input taking the caret begins editing in this same turn.
        handing = true
        DispatchQueue.main.async { [self] in
            guard handing else { return }
            handing = false
            resigned = true
            if noteId != nil { end() }
        }
    }

    /// `input` took the caret from the holder: it gets the held keys. A
    /// later ⌘N's holder is not a taker: this hold's note keeps its keys.
    private func began(_ input: UIKeyInput?) {
        guard handing, let input, !(input is KeyHolder), let holder else { return }
        handing = false
        let text = holder.text ?? ""
        finish()
        if !text.isEmpty { input.insertText(text) }
    }

    /// Ends the hold. Keys no text input took become the new note's title.
    private func end() {
        guard let holder else { return }
        let text = holder.text ?? ""
        let keep = keep
        finish()
        holder.resignFirstResponder()
        if let noteId, !text.isEmpty { keep?(noteId, text) }
    }

    private func finish() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        holder?.hold = nil
        holder?.removeFromSuperview()
        holder = nil
        keep = nil
    }
}

/// The hidden text view that holds the keys.
private final class KeyHolder: UITextView {
    var hold: NewNoteKeys?

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        alpha = 0
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        autocorrectionType = .no
        spellCheckingType = .no
        smartQuotesType = .no
        smartDashesType = .no
        smartInsertDeleteType = .no
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { hold?.holderResigned() }
        return resigned
    }
}
