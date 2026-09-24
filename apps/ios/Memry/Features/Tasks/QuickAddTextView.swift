import MemryCore
import SwiftUI
import UIKit

// TP042. The quick-add field: a `UITextView` whose syntax runs are painted as
// pills from the core's parse spans (desktop's `TokenOverlay`), with the
// ghost completion drawn after the caret.
//
// **Why UIKit**: a SwiftUI `TextField` cannot colour ranges of its own input,
// report the caret, or intercept Tab. The attributes are laid over the text
// storage without replacing the string, so the caret, marked text (IME) and
// undo survive every repaint.

/// A multi-line capture field that submits on Return.
struct QuickAddTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    /// The core's spans for `text`; empty while a parse is in flight.
    let spans: [QuickAddSpan]
    /// The parsed priority, which colours `!priority` runs (0 none).
    let priority: Int64
    /// The not-yet-typed completion, drawn after the caret.
    let ghost: String?
    let placeholder: String
    let onSubmit: () -> Void
    let onAcceptGhost: () -> Void
    /// Bumped by the owner to move focus into the field.
    var focusRequest = 0

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(
            top: Tokens.Space.small, left: 0, bottom: Tokens.Space.small, right: 0
        )
        view.textContainer.lineFragmentPadding = 0
        view.font = Self.font
        view.adjustsFontForContentSizeCategory = true
        view.textColor = Tokens.Text.primary.uiColor
        view.returnKeyType = .done
        view.autocorrectionType = .default
        view.accessibilityLabel = TasksCopy.quickAddLabel
        view.accessibilityIdentifier = "tasks.quickAdd.field"
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let placeholderLabel = context.coordinator.placeholder
        placeholderLabel.font = Self.font
        placeholderLabel.adjustsFontForContentSizeCategory = true
        placeholderLabel.textColor = Tokens.Text.tertiary.uiColor
        placeholderLabel.numberOfLines = 1
        placeholderLabel.isAccessibilityElement = false
        view.addSubview(placeholderLabel)

        let ghostLabel = context.coordinator.ghostLabel
        ghostLabel.font = Self.font
        ghostLabel.adjustsFontForContentSizeCategory = true
        ghostLabel.textColor = Tokens.Text.tertiary.uiColor
        ghostLabel.isAccessibilityElement = false
        view.addSubview(ghostLabel)
        return view
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: max(ceil(fitted.height), Tokens.Size.minimumHitArea))
    }

    func updateUIView(_ view: UITextView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        if view.text != text, view.markedTextRange == nil {
            view.text = text
        }
        if view.markedTextRange == nil {
            Self.paint(view, spans: spans, priority: priority)
        }
        coordinator.placeholder.text = placeholder
        coordinator.placeholder.isHidden = !text.isEmpty
        coordinator.layoutOverlays(in: view)
        if focusRequest != coordinator.focusRequest {
            coordinator.focusRequest = focusRequest
            DispatchQueue.main.async { view.becomeFirstResponder() }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    static var font: UIFont { UIFont.preferredFont(forTextStyle: Tokens.Typography.body.ramp.uiTextStyle) }

    /// The colour of a span, `TOKEN_STYLES` in `capture-bar-tokens.tsx`.
    static func color(kind: String, priority: Int64) -> UIColor {
        switch kind {
        case "datePhrase": Tokens.Task.tokenDate.uiColor
        case "repeat": Tokens.Task.repeatMark.uiColor
        case "project": Tokens.Task.tokenProject.uiColor
        case "tag": Tokens.Task.tokenTag.uiColor
        case "noteLink": Tokens.Task.tokenNote.uiColor
        case "priority" where priority > 0: Tokens.Task.priority(priority).uiColor
        default: Tokens.Text.secondary.uiColor
        }
    }

    /// Lays the span colours over the stored text, keeping the selection.
    static func paint(_ view: UITextView, spans: [QuickAddSpan], priority: Int64) {
        let storage = view.textStorage
        let whole = NSRange(location: 0, length: storage.length)
        let selection = view.selectedRange
        storage.beginEditing()
        storage.setAttributes([.font: font, .foregroundColor: Tokens.Text.primary.uiColor], range: whole)
        for span in spans {
            let range = NSRange(location: Int(span.start), length: Int(span.end) - Int(span.start))
            guard range.length > 0, NSMaxRange(range) <= storage.length else { continue }
            let ink = color(kind: span.kind, priority: priority)
            storage.addAttributes([
                .foregroundColor: ink,
                .backgroundColor: ink.withAlphaComponent(Tokens.Palette.chipFillAlpha)
            ], range: range)
        }
        storage.endEditing()
        view.selectedRange = selection
        view.typingAttributes = [.font: font, .foregroundColor: Tokens.Text.primary.uiColor]
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: QuickAddTextView
        var focusRequest = 0
        let placeholder = UILabel()
        let ghostLabel = UILabel()

        init(parent: QuickAddTextView) {
            self.parent = parent
        }

        /// Places the placeholder at the text origin and the ghost right after
        /// the caret, only while the caret is at the end (where the ghost is
        /// true).
        func layoutOverlays(in view: UITextView) {
            let origin = CGPoint(x: view.textContainerInset.left, y: view.textContainerInset.top)
            placeholder.frame = CGRect(
                origin: origin,
                size: CGSize(width: max(view.bounds.width - origin.x, 0), height: Self.lineHeight)
            )
            let atEnd = view.selectedRange == NSRange(location: view.textStorage.length, length: 0)
            guard let ghost = parent.ghost, !ghost.isEmpty, atEnd, view.isFirstResponder else {
                ghostLabel.isHidden = true
                return
            }
            let caret = view.caretRect(for: view.endOfDocument)
            ghostLabel.text = ghost
            ghostLabel.isHidden = false
            let width = max(view.bounds.width - caret.maxX, 0)
            ghostLabel.frame = CGRect(x: caret.maxX, y: caret.minY, width: width, height: caret.height)
        }

        private static var lineHeight: CGFloat { QuickAddTextView.font.lineHeight }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text ?? ""
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            layoutOverlays(in: textView)
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.isFocused = true
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            parent.isFocused = false
            ghostLabel.isHidden = true
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText replacement: String
        ) -> Bool {
            switch replacement {
            case "\n":
                // Return submits exactly what is on screen; a suggestion is
                // never captured by accident (desktop's Enter).
                parent.onSubmit()
                return false
            case "\t" where parent.ghost != nil:
                parent.onAcceptGhost()
                return false
            default:
                return true
            }
        }
    }
}
