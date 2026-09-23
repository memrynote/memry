//
//  EditableBlockView.swift
//  One editable block, which N300 decided is one `UITextView`.
//
//  The spike's answer, made concrete: a block is a real `UITextView`, so
//  dictation, autocorrect and the IME candidate window work inside a block
//  without the shell reimplementing any of them. What the shell owns is the
//  boundary between blocks, which is N501.
//

import SwiftUI
import UIKit

/// A single editable block, bridged from UIKit.
///
/// **Why UIKit rather than SwiftUI's `TextField`**: a `TextField` gives no
/// access to the selected range, the caret, or the first-responder transitions
/// that crossing a block boundary needs. N300 measured a real `UITextView`
/// and this is that view.
struct EditableBlockView: UIViewRepresentable {
    /// The text as the document currently holds it.
    let text: String
    /// The type role this block renders in, so a heading looks like a heading
    /// while it is being edited rather than only after.
    var role: TypeRole.Ramp = .body
    /// The block's `textAlignment`, which a text view can honour in full,
    /// including `justify`.
    var alignment: NSTextAlignment = .natural
    /// The block's own `textColor`, or `nil` for the ordinary ink.
    var ink: UIColor?
    /// Called when the user stops typing, with the text to commit.
    ///
    /// **Not called per keystroke.** Every call becomes a CRDT update and an
    /// outbox row (FR-030); one per character would be thousands of rows for
    /// one paragraph.
    let commit: (String) -> Void
    /// Called when the caret reaches past the end of the block, which is the
    /// boundary case N501 owns.
    var onReturn: (() -> Void)?

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.font = UIFont.preferredFont(forTextStyle: role.uiTextStyle)
        // Dynamic Type, which a hard-coded font size would lose.
        view.adjustsFontForContentSizeCategory = true
        view.textAlignment = alignment
        view.textColor = ink ?? UIColor(Tokens.Text.primary.color)
        view.text = text
        // A non-scrolling text view reports its whole text on one line as its
        // intrinsic width, which would push the note wider than the screen.
        // The width comes from the proposal in `sizeThatFits` instead.
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    /// Takes the offered width and grows vertically to fit the wrapped text.
    ///
    /// Without this SwiftUI sizes the view from `intrinsicContentSize`, which
    /// for a `UITextView` with scrolling off is the unwrapped line: every
    /// paragraph ran off both edges and dragged the whole page wide with it.
    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UITextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let fitted = uiView.sizeThatFits(
            CGSize(width: width, height: .greatestFiniteMagnitude)
        )
        return CGSize(width: width, height: ceil(fitted.height))
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.commit = commit
        context.coordinator.onReturn = onReturn
        view.font = UIFont.preferredFont(forTextStyle: role.uiTextStyle)
        view.textAlignment = alignment
        view.textColor = ink ?? UIColor(Tokens.Text.primary.color)
        // **Only when it actually differs.** Assigning `text` unconditionally
        // resets the selection to the end on every SwiftUI update, which moves
        // the user's caret while they are typing.
        if view.text != text && !view.isFirstResponder {
            view.text = text
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(commit: commit, onReturn: onReturn)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var commit: (String) -> Void
        var onReturn: (() -> Void)?

        init(commit: @escaping (String) -> Void, onReturn: (() -> Void)?) {
            self.commit = commit
            self.onReturn = onReturn
        }

        /// Committed when editing ends rather than per keystroke, for the
        /// reason on ``EditableBlockView/commit``.
        func textViewDidEndEditing(_ textView: UITextView) {
            commit(textView.text ?? "")
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText text: String
        ) -> Bool {
            guard text == "\n", let onReturn else { return true }
            // A newline inside a block is a new block, not a line break: the
            // document is a list of blocks and a `\n` in one would be a
            // paragraph the reader cannot address.
            commit(textView.text ?? "")
            onReturn()
            return false
        }
    }
}
