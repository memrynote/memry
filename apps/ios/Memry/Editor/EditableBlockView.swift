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
        let nextInk = ink ?? Self.primaryInk
        // Inks compare resolved: every update builds a new dynamic `UIColor`,
        // and a dynamic colour equals only itself, so comparing the colours
        // themselves re-renders on every update. That re-render moves the
        // caret, which reopens the `#` menu, which updates the view again.
        let traits = view.traitCollection
        let changed = field.block != block || field.style.font != Self.font(for: role) || field.alignment != alignment
            || field.style.ink.resolvedColor(with: traits) != nextInk.resolvedColor(with: traits)
        field.block = block
        field.session = session
        field.alignment = alignment
        field.style = BlockText.Style(font: Self.font(for: role), ink: nextInk, titleExists: session.titleExists, tagColors: session.tagColors)
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
        BlockField(block: block, session: session, style: BlockText.Style(font: Self.font(for: role), ink: ink ?? Self.primaryInk, titleExists: session.titleExists, tagColors: session.tagColors), alignment: alignment)
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
/// TextKit 1, so a typed `#tag`'s fill can be drawn as desktop's pill.
final class BlockTextView: UITextView {
    /// A layout manager holds its storage weakly; this keeps it alive.
    private let storage: NSTextStorage

    init() {
        let storage = NSTextStorage()
        let layout = TagPillLayoutManager()
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        self.storage = storage
        super.init(frame: .zero, textContainer: container)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
}

/// Draws the fill under a typed `#tag` (`BlockText.markTags`) as a rounded
/// pill, padded into the kern around it. Other fills draw as usual.
final class TagPillLayoutManager: NSLayoutManager {
    override func fillBackgroundRectArray(
        _ rectArray: UnsafePointer<CGRect>,
        count rectCount: Int,
        forCharacterRange charRange: NSRange,
        color: UIColor
    ) {
        guard let storage = textStorage, charRange.location < storage.length,
              storage.attribute(.memryTag, at: charRange.location, effectiveRange: nil) != nil,
              let context = UIGraphicsGetCurrentContext()
        else {
            super.fillBackgroundRectArray(rectArray, count: rectCount, forCharacterRange: charRange, color: color)
            return
        }
        let font = storage.attribute(.font, at: charRange.location, effectiveRange: nil) as? UIFont
        let height = (font?.lineHeight ?? 16) + 2
        context.saveGState()
        color.setFill()
        for index in 0..<rectCount {
            let rect = rectArray[index]
            // The tag's own glyphs, without the trailing kern, padded evenly.
            let width = rect.width - BlockText.tagPillPadding + BlockText.tagPillPadding * 2
            let pill = CGRect(
                x: rect.minX - BlockText.tagPillPadding,
                y: rect.midY - height / 2,
                width: width,
                height: min(height, rect.height)
            )
            UIBezierPath(roundedRect: pill, cornerRadius: min(10, pill.height / 2)).fill()
        }
        context.restoreGState()
    }
}

/// One block's editing state, and the text view's delegate.
@MainActor
final class BlockField: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
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
    /// Inside `render`, whose `attributedText` puts the caret at the end before
    /// the old selection goes back: the session sees only where it lands.
    private var rendering = false

    init(block: Block, session: EditorSession, style: BlockText.Style, alignment: NSTextAlignment) {
        self.block = block
        self.session = session
        self.style = style
        self.alignment = alignment
        super.init()
        let tap = UITapGestureRecognizer(target: self, action: #selector(openTappedTag(_:)))
        tap.delegate = self
        textView.addGestureRecognizer(tap)
    }

    var blockId: String { block.id ?? "" }

    // MARK: Tapping a tag or a date

    /// A tap on a `#tag` opens its notes, as a click on desktop's chip does,
    /// and a tap on a date or reminder opens its editor, as a click on
    /// desktop's pill does, instead of putting the caret in it. Begins only
    /// over one of them, so every other tap is the text view's own.
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        let point = gestureRecognizer.location(in: textView)
        if date(at: point) != nil { return true }
        return session?.openTag != nil && tag(at: point) != nil
    }

    /// The text view's own taps wait for this one to fail, so a tap that
    /// opens a tag does not also move the caret.
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        otherGestureRecognizer is UITapGestureRecognizer
            && otherGestureRecognizer.view?.isDescendant(of: textView) == true
    }

    @objc private func openTappedTag(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: textView)
        if let date = date(at: point) {
            session?.requestDateEdit(date, in: self)
        } else if let tag = tag(at: point) {
            session?.openTag?(tag)
        }
    }

    private func tag(at point: CGPoint) -> String? {
        attribute(.memryTag, at: point)
    }

    private func date(at point: CGPoint) -> DateMentionChip? {
        attribute(.memryDate, at: point)
    }

    /// The `key` value drawn under `point`, if the point is on its glyphs.
    private func attribute<Value>(_ key: NSAttributedString.Key, at point: CGPoint) -> Value? {
        guard let range = textView.characterRange(at: point) else { return nil }
        let offset = textView.offset(from: textView.beginningOfDocument, to: range.start)
        guard offset >= 0, offset < textView.textStorage.length,
              let value = textView.textStorage.attribute(key, at: offset, effectiveRange: nil) as? Value,
              textView.firstRect(for: range).insetBy(dx: -4, dy: -4).contains(point)
        else { return nil }
        return value
    }

    /// Where the chip with `anchorId` is drawn now, in the text view's units.
    func dateChipRange(anchorId: String) -> NSRange? {
        var found: NSRange?
        let storage = textView.textStorage
        storage.enumerateAttribute(.memryDate, in: NSRange(location: 0, length: storage.length)) { value, range, stop in
            if (value as? DateMentionChip)?.anchorId == anchorId {
                found = range
                stop.pointee = true
            }
        }
        return found
    }

    func value(_ name: String) -> String? {
        block.props.first { $0.name == name }?.value
    }

    func render() {
        let selection = pendingSelection ?? textView.selectedRange
        pendingSelection = nil
        rendering = true
        defer {
            rendering = false
            if textView.isFirstResponder { session?.selectionChanged(in: self) }
        }
        let text = NSMutableAttributedString(attributedString: BlockText.attributed(block.inline, style: style))
        if block.kind != "codeBlock" { BlockText.markTags(in: text, colors: style.tagColors) }
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
        } else if textView.typingAttributes[.memryTag] != nil {
            // Typed after a `#tag` drawn as one: ordinary text until the next
            // render reads it again.
            textView.typingAttributes[.memryTag] = nil
            textView.typingAttributes[.foregroundColor] = style.ink
        }
        if !rendering { session?.selectionChanged(in: self) }
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
