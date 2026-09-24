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
    /// The composer submits with "next" and keeps going (RD03).
    var returnKey: UIReturnKeyType = .done
    /// A keyboard bar with Done, for a field that has no other way out.
    var showsDismissBar = true
    var identifier = "tasks.quickAdd.field"
    /// Hardware Esc while the field has focus (the composer closes on it).
    var onEscape: (() -> Void)?

    func makeUIView(context: Context) -> UITextView {
        let view = QuickAddUITextView()
        view.delegate = context.coordinator
        view.onEscape = { [weak coordinator = context.coordinator] in coordinator?.parent.onEscape?() }
        // The overlays follow the view's own layout: an update can arrive
        // before the view has a width, which left the placeholder zero-wide
        // until something else redrew the field.
        let coordinator = context.coordinator
        view.onLayout = { [weak coordinator] layoutView in coordinator?.layoutOverlays(in: layoutView) }
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(
            top: Tokens.Space.small, left: 0, bottom: Tokens.Space.small, right: 0
        )
        view.textContainer.lineFragmentPadding = 0
        view.font = Self.font
        view.adjustsFontForContentSizeCategory = true
        view.textColor = Tokens.Text.primary.uiColor
        view.returnKeyType = returnKey
        view.autocorrectionType = .default
        view.accessibilityLabel = TasksCopy.quickAddLabel
        view.accessibilityIdentifier = identifier
        if showsDismissBar { view.inputAccessoryView = Self.dismissBar(for: view) }
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let placeholderLabel = context.coordinator.placeholder
        placeholderLabel.font = Self.font
        placeholderLabel.adjustsFontForContentSizeCategory = true
        placeholderLabel.textColor = Tokens.Text.tertiary.uiColor
        // Wraps at large text sizes instead of clipping; the field grows to it.
        placeholderLabel.numberOfLines = 0
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

    /// Return submits and keeps the focus (rapid entry, as on desktop), so
    /// the keyboard carries its own way out; the field may sit over a list
    /// too short to scroll it away.
    private static func dismissBar(for view: UITextView) -> UIToolbar {
        let bar = UIToolbar()
        bar.sizeToFit()
        let done = UIBarButtonItem(
            systemItem: .done,
            primaryAction: UIAction { [weak view] _ in view?.resignFirstResponder() }
        )
        done.accessibilityIdentifier = "tasks.quickAdd.dismissKeyboard"
        bar.items = [UIBarButtonItem(systemItem: .flexibleSpace), done]
        return bar
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        var height = fitted.height
        if uiView.text.isEmpty {
            let insets = uiView.textContainerInset
            let placeholder = context.coordinator.placeholder.sizeThatFits(
                CGSize(width: max(width - insets.left - insets.right, 0), height: .greatestFiniteMagnitude)
            )
            height = max(height, placeholder.height + insets.top + insets.bottom)
        }
        return CGSize(width: width, height: max(ceil(height), Tokens.Size.minimumHitArea))
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
            let lineWidth = max(view.bounds.width - origin.x - view.textContainerInset.right, 0)
            let height = placeholder.sizeThatFits(CGSize(width: lineWidth, height: .greatestFiniteMagnitude)).height
            placeholder.frame = CGRect(
                origin: origin, size: CGSize(width: lineWidth, height: max(height, Self.lineHeight))
            )
            let atEnd = view.selectedRange == NSRange(location: view.textStorage.length, length: 0)
            guard let ghost = parent.ghost, !ghost.isEmpty, atEnd, view.isFirstResponder else {
                ghostLabel.isHidden = true
                return
            }
            let caret = view.caretRect(for: view.endOfDocument)
            ghostLabel.text = ghost
            ghostLabel.isHidden = false
            // Toward the writing direction: after the caret on the right in
            // left-to-right text, before it on the left in right-to-left text.
            if view.effectiveUserInterfaceLayoutDirection == .rightToLeft {
                ghostLabel.textAlignment = .right
                ghostLabel.frame = CGRect(x: 0, y: caret.minY, width: max(caret.minX, 0), height: caret.height)
            } else {
                ghostLabel.textAlignment = .left
                let width = max(view.bounds.width - caret.maxX, 0)
                ghostLabel.frame = CGRect(x: caret.maxX, y: caret.minY, width: width, height: caret.height)
            }
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

/// A text view that reports each layout pass, so the placeholder and ghost
/// overlays are placed once it has its real size.
private final class QuickAddUITextView: UITextView {
    var onLayout: ((UITextView) -> Void)?
    var onEscape: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?(self)
    }

    /// A focused text view swallows Esc before SwiftUI's shortcuts see it.
    override var keyCommands: [UIKeyCommand]? {
        let escape = UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(escapePressed))
        escape.wantsPriorityOverSystemBehavior = true
        return (super.keyCommands ?? []) + [escape]
    }

    @objc private func escapePressed() {
        onEscape?()
    }
}
