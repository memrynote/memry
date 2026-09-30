//
//  EditableBlockView.swift
//  One editable block, which N300 decided is one `UITextView`.
//
//  The spike's answer, made concrete: a block is a real `UITextView`, so
//  dictation, autocorrect and the IME candidate window work inside a block
//  without the shell reimplementing any of them. The text view holds the
//  block's marks and inline nodes as attributed text (`BlockText`), carries
//  the page's keyboard toolbar as its input accessory, and writes through the
//  page's `EditorSession`.
//

import MemryCore
import SwiftUI
import UIKit

/// A single editable block, bridged from UIKit.
///
/// **Why UIKit rather than SwiftUI's `TextField`**: a `TextField` gives no
/// access to the selected range, the caret, or the first-responder transitions
/// that crossing a block boundary needs.
struct EditableBlockView: UIViewRepresentable {
    let block: Block
    let session: EditorSession
    /// The type role this block renders in, so a heading looks like a heading
    /// while it is being edited rather than only after.
    var role: TypeRole = Tokens.Typography.body
    /// The block's `textAlignment`, which a text view can honour in full.
    var alignment: NSTextAlignment = .natural
    /// The block's own ink, or `nil` for the ordinary ink.
    var ink: UIColor?

    func makeUIView(context: Context) -> BlockTextView {
        let view = context.coordinator.textView
        view.delegate = context.coordinator
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.inputAccessoryView = session.accessory
        // A non-scrolling text view reports its whole text on one line as its
        // intrinsic width; the width comes from `sizeThatFits` instead.
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.accessibilityIdentifier = "note.block.\(block.id ?? "")"
        context.coordinator.render()
        return view
    }

    /// Takes the offered width and grows vertically to fit the wrapped text.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: BlockTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: ceil(fitted.height))
    }

    func updateUIView(_ view: BlockTextView, context: Context) {
        let field = context.coordinator
        let changed = field.block != block || field.style.font != Self.font(for: role) || field.alignment != alignment
            || field.style.ink != (ink ?? Self.primaryInk)
        field.block = block
        field.session = session
        field.alignment = alignment
        field.style = BlockText.Style(font: Self.font(for: role), ink: ink ?? Self.primaryInk, titleExists: session.titleExists)
        // **Only when it differs, and never over unsaved typing.** Re-rendering
        // resets the text storage, which would move a caret mid-word or drop
        // what the user typed since the last commit.
        if changed, !field.dirty { field.render() }
        // The block changed under a text view that kept the caret (a type
        // change that kept the row's shape): nothing is left to focus.
        if changed, session.pendingFocus == field.blockId, view.isFirstResponder {
            session.pendingFocus = nil
        }
        if session.pendingFocus == field.blockId, !view.isFirstResponder {
            session.pendingFocus = nil
            DispatchQueue.main.async {
                view.becomeFirstResponder()
                view.selectedRange = NSRange(location: view.textStorage.length, length: 0)
            }
        }
    }

    func makeCoordinator() -> BlockField {
        BlockField(block: block, session: session, style: BlockText.Style(font: Self.font(for: role), ink: ink ?? Self.primaryInk, titleExists: session.titleExists), alignment: alignment)
    }

    static var primaryInk: UIColor { UIColor(Tokens.Text.primary.color) }

    /// A type role as a Dynamic Type `UIFont`, weight and design included.
    static func font(for role: TypeRole) -> UIFont {
        let style = role.ramp.uiTextStyle
        let base = UIFont.preferredFont(forTextStyle: style, compatibleWith: UITraitCollection(preferredContentSizeCategory: .large))
        let weight: UIFont.Weight = switch role.weight {
        case .semibold: .semibold
        case .bold: .bold
        case .medium: .medium
        default: .regular
        }
        var font = UIFont.systemFont(ofSize: base.pointSize, weight: weight)
        if role.design == .monospaced {
            font = UIFont.monospacedSystemFont(ofSize: base.pointSize, weight: weight)
        } else if role.design == .serif, let serif = font.fontDescriptor.withDesign(.serif) {
            font = UIFont(descriptor: serif, size: base.pointSize)
        }
        return UIFontMetrics(forTextStyle: style).scaledFont(for: font)
    }
}

/// The text view a block edits in.
final class BlockTextView: UITextView {}

/// One block's editing state, and the text view's delegate.
@MainActor
final class BlockField: NSObject, UITextViewDelegate {
    var block: Block
    weak var session: EditorSession?
    var style: BlockText.Style
    var alignment: NSTextAlignment
    /// Owned here, handed to SwiftUI by `makeUIView`.
    let textView = BlockTextView()
    /// Typed since the last commit.
    var dirty = false
    /// The text the user's typing started from: what was last drawn or
    /// committed. While `dirty`, `block` can move on under the text view (a
    /// peer's edit merging in), and a commit sends only the change from
    /// here, so it lands on the live block without deleting the peer's edit.
    var base = ""
    /// Where the caret goes after the next render (a mark, a chosen link).
    var pendingSelection: NSRange?

    init(block: Block, session: EditorSession, style: BlockText.Style, alignment: NSTextAlignment) {
        self.block = block
        self.session = session
        self.style = style
        self.alignment = alignment
    }

    var blockId: String { block.id ?? "" }

    func value(_ name: String) -> String? {
        block.props.first { $0.name == name }?.value
    }

    func render() {
        let selection = pendingSelection ?? textView.selectedRange
        pendingSelection = nil
        let text = NSMutableAttributedString(attributedString: BlockText.attributed(block.inline, style: style))
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        text.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: text.length))
        textView.attributedText = text
        base = text.string
        textView.typingAttributes = BlockText.baseAttributes(style)
        if textView.isFirstResponder {
            let location = min(selection.location, text.length)
            textView.selectedRange = NSRange(location: location, length: min(selection.length, text.length - location))
        }
        textView.invalidateIntrinsicContentSize()
    }

    /// Draws each typed `[[target]]` as the link chip the commit turns it
    /// into, keeps the caret on the same text, and takes the result as the
    /// next commit's base: the block the core holds once the link lands.
    func drawLinks(_ links: [WikiLinkText.Match]) {
        var caret = textView.selectedRange.location
        for link in links.reversed() {
            let attrs = WikiLinkAttrs.attrs(target: link.target, alias: link.alias)
            let run = InlineRun(
                text: "", marks: ["wikiLink"],
                markAttrs: ["wikiLink.target": attrs["target"] ?? link.target, "wikiLink.alias": attrs["alias"] ?? ""],
                target: nil
            )
            let chip = NSMutableAttributedString(attributedString: BlockText.attributed([run], style: style))
            if let paragraph = textView.textStorage.attribute(.paragraphStyle, at: link.range.location, effectiveRange: nil) {
                chip.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: chip.length))
            }
            textView.textStorage.replaceCharacters(in: link.range, with: chip)
            if caret >= NSMaxRange(link.range) {
                caret -= link.range.length - chip.length
            } else if caret > link.range.location {
                caret = link.range.location + chip.length
            }
        }
        base = textView.textStorage.string
        textView.selectedRange = NSRange(location: min(caret, textView.textStorage.length), length: 0)
        textView.typingAttributes = BlockText.baseAttributes(style)
        textView.invalidateIntrinsicContentSize()
    }

    // MARK: UITextViewDelegate

    func textViewDidBeginEditing(_ textView: UITextView) {
        session?.focusChanged(to: self)
    }

    /// Committed when editing ends rather than per keystroke: every commit is a
    /// CRDT update and an outbox row (FR-030).
    func textViewDidEndEditing(_ textView: UITextView) {
        session?.commit(self)
        if session?.field === self { session?.focusChanged(to: nil) }
    }

    func textViewDidChange(_ textView: UITextView) {
        dirty = true
        textView.invalidateIntrinsicContentSize()
        session?.selectionChanged(in: self)
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        // A character typed after a chip must not inherit the chip's node
        // bytes, or every offset after it would be wrong.
        if textView.typingAttributes[.memryNodeBytes] != nil || textView.typingAttributes[.attachment] != nil {
            textView.typingAttributes = BlockText.baseAttributes(style)
        }
        session?.selectionChanged(in: self)
    }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        let string = textView.text as NSString
        // `[[` becomes `[[]]` with the caret between (desktop's autocomplete),
        // outside a code block, whose text stays literal.
        if text == "[", range.length == 0, range.location > 0, block.kind != "codeBlock",
           string.character(at: range.location - 1) == 91 {
            textView.textStorage.replaceCharacters(
                in: range, with: NSAttributedString(string: "[]]", attributes: textView.typingAttributes)
            )
            textView.selectedRange = NSRange(location: range.location + 1, length: 0)
            textViewDidChange(textView)
            return false
        }
        // Typing `]` before an autocompleted `]]` steps over it.
        if text == "]", range.length == 0, range.location + 2 <= string.length,
           string.substring(with: NSRange(location: range.location, length: 2)) == "]]" {
            textView.selectedRange = NSRange(location: range.location + 2, length: 0)
            return false
        }
        // Return picks the slash menu's first row, as Enter does on desktop.
        if text == "\n", let session, case .slash = session.trigger, let first = session.suggestions.first {
            session.choose(first)
            return false
        }
        if text == "\n", block.kind != "codeBlock" {
            session?.returnPressed(self)
            return false
        }
        if applyMarkdownShortcut(textView, range: range, text: text) { return false }
        if text.isEmpty, range.location == 0, range.length == 0, string.length == 0 {
            session?.backspaceAtStart(self)
        }
        return true
    }

    /// The edit menu over a selection gains a Format submenu: the same marks
    /// the keyboard toolbar's `Aa` panel writes.
    func textView(
        _ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]
    ) -> UIMenu? {
        guard range.length > 0, let session else { return nil }
        return UIMenu(children: [FormatEditMenu.menu(session: session, textView: textView)] + suggestedActions)
    }
}

extension EditorSession {
    private static let continuingKinds: Set<String> = ["bulletListItem", "numberedListItem", "checkListItem"]

    /// Return: a new block below, the same kind for a list item (desktop);
    /// an empty list item or heading becomes a paragraph instead.
    func returnPressed(_ field: BlockField) {
        let kind = field.block.kind
        let empty = field.textView.text.isEmpty
        if empty, kind != "paragraph" {
            turnInto(InsertableBlock.all[0])
            return
        }
        let next = Self.continuingKinds.contains(kind) ? kind : "paragraph"
        commit(field) { [weak self] in
            guard let self, let model = self.model else { return }
            guard let newId = await model.insert(next, after: field.blockId) else { return }
            self.history.record(.insert(blockId: newId, after: field.blockId, kind: next, text: ""))
            self.pendingFocus = newId
        }
    }

    /// Backspace in an empty block that is not a paragraph turns it into one,
    /// as desktop does before it deletes anything.
    func backspaceAtStart(_ field: BlockField) {
        guard field.block.kind != "paragraph" else { return }
        turnInto(InsertableBlock.all[0])
    }
}
