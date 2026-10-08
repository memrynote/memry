//
//  SourceTextInput.swift
//  Text input for source: a code block's text and the math and diagram
//  source sheet. The keyboard leaves it exactly as typed.
//

import SwiftUI
import UIKit

extension UITextView {
    /// Source typing (`true`) turns off what the keyboard rewrites: Smart
    /// Punctuation would make `--` an em dash and `"` a curly quote, which
    /// breaks a `memry-view` fence and a mermaid `-->` arrow, and
    /// autocorrect and capitalisation rewrite identifiers. Prose (`false`)
    /// gets the system defaults back. A block turned into code while it has
    /// the caret gets the new keyboard at once.
    func useSourceInput(_ source: Bool) {
        guard smartDashesType != (source ? .no : .default) else { return }
        autocorrectionType = source ? .no : .default
        spellCheckingType = source ? .no : .default
        autocapitalizationType = source ? .none : .sentences
        smartDashesType = source ? .no : .default
        smartQuotesType = source ? .no : .default
        smartInsertDeleteType = source ? .no : .default
        if isFirstResponder { reloadInputViews() }
    }
}

/// A multi-line field for LaTeX or mermaid source, grown to between three and
/// twelve lines. UIKit rather than a SwiftUI `TextField`, which has no way to
/// turn off Smart Punctuation.
struct SourceTextView: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let label: String

    private static let font = EditableBlockView.font(for: Tokens.Typography.recoveryMaterial)

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.useSourceInput(true)
        view.keyboardType = .asciiCapable
        view.font = Self.font
        view.adjustsFontForContentSizeCategory = true
        view.textColor = Tokens.Text.primary.uiColor
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.accessibilityLabel = label
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.text = text
        let placeholderLabel = context.coordinator.placeholder
        placeholderLabel.font = Self.font
        placeholderLabel.adjustsFontForContentSizeCategory = true
        placeholderLabel.textColor = Tokens.Text.tertiary.uiColor
        placeholderLabel.isAccessibilityElement = false
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(placeholderLabel)
        NSLayoutConstraint.activate([
            placeholderLabel.leadingAnchor.constraint(equalTo: view.frameLayoutGuide.leadingAnchor),
            placeholderLabel.topAnchor.constraint(equalTo: view.frameLayoutGuide.topAnchor),
        ])
        DispatchQueue.main.async { view.becomeFirstResponder() }
        return view
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let line = uiView.font?.lineHeight ?? 20
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        return CGSize(width: width, height: ceil(min(max(fitted, line * 3), line * 12)))
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text, view.markedTextRange == nil { view.text = text }
        context.coordinator.placeholder.text = placeholder
        context.coordinator.placeholder.isHidden = !text.isEmpty
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: SourceTextView
        let placeholder = UILabel()

        init(_ parent: SourceTextView) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            placeholder.isHidden = !textView.text.isEmpty
        }
    }
}
