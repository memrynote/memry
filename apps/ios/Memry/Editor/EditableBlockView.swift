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
        session.drawn(context.coordinator)
        context.coordinator.render()
        return view
    }

    /// #4346: a page swapped out in place (the iPad split view's detail
    /// column opening another note) removes its text views without ending
    /// their edits, so typing not yet committed would be lost with them.
    static func dismantleUIView(_ view: BlockTextView, coordinator: BlockField) {
        // A row a type change redraws goes before it resigns (REVIEW-4714).
        coordinator.session?.returnBurstEnded(in: coordinator, leaving: true)
        if coordinator.dirty { coordinator.commitTyping() }
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
        let restyled = field.style.font != Self.font(for: role) || field.alignment != alignment
            || field.style.ink.resolvedColor(with: traits) != nextInk.resolvedColor(with: traits)
            || field.style.struck != struck
        let moved = field.block.id != block.id
        field.session = session
        field.alignment = alignment
        field.style = BlockText.Style(
            font: Self.font(for: role), ink: nextInk, titleExists: session.titleExists,
            tagColors: session.tagColors, struck: struck
        )
        let changed = field.receive(block, generation: session.drawnGeneration(), restyled: restyled)
        // Rows are drawn by position: a block inserted or removed above hands
        // this text view the next block, which `focus` must find it under.
        if moved { session.drawn(field) }
        // The block changed under a text view that kept the caret (a type
        // change that kept the row's shape): nothing is left to focus.
        if changed, session.pendingFocus == field.blockId, view.isFirstResponder {
            session.pendingFocus = nil
            session.shortcutField = nil
        }
        if session.pendingFocus == field.blockId, !view.isFirstResponder, !session.takesCaretOnArrival(field) {
            session.pendingFocus = nil
            DispatchQueue.main.async {
                // A row a shortcut redrew takes its caret from the old row
                // as it begins editing (`textViewDidBeginEditing`).
                let handover = session.shortcutField?.blockId == field.blockId
                session.takeCaret(field, atEnd: !handover)
            }
        }
    }

    func makeCoordinator() -> BlockField {
        let style = BlockText.Style(
            font: Self.font(for: role), ink: ink ?? Self.primaryInk, titleExists: session.titleExists,
            tagColors: session.tagColors, struck: struck
        )
        return BlockField(block: block, session: session, style: style, alignment: alignment)
    }

    /// A ticked checklist item, drawn struck through.
    private var struck: Bool {
        block.kind == "checkListItem" && block.props.contains { $0.name == "checked" && $0.value == "true" }
    }

    /// The text view with its first baseline where its first line's is,
    /// for a row that aligns a marker on `.firstTextBaseline`. UIKit puts an
    /// empty text view's baseline at its top, which drew an empty checklist
    /// item's caret a line below its box. With no inset or padding the
    /// first baseline is the font's ascender, empty or not.
    var baselineAligned: some View {
        alignmentGuide(.firstTextBaseline) { _ in Self.font(for: role).ascender }
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
    /// Backspace with the caret at the start and nothing selected. UIKit asks
    /// the delegate about no change then, since there is nothing to delete.
    var backspaceAtStart: (() -> Void)?
    /// The view moved into a window, or out of one (#4457).
    var movedToWindow: ((UIWindow?) -> Void)?
    /// The view was laid out again, as when the page beside a list changes width.
    var laidOut: (() -> Void)?
    /// The editor's hardware keys (#4354): which apply now, and the handler.
    var editorKeys: (() -> [EditorKeyCommand])?
    var editorKeyPressed: ((EditorKeyCommand) -> Void)?
    /// A hardware key went down, with the text it types.
    var keyWentDown: ((String) -> Void)?
    /// Offered the pasteboard's text on a paste: `true` when it took it
    /// (`EditorSession.pasteMarkdown`), else the text view pastes it.
    var pastesText: ((String) -> Bool)?

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

    override func deleteBackward() {
        guard selectedRange == NSRange(location: 0, length: 0), markedTextRange == nil,
              let backspaceAtStart
        else { return super.deleteBackward() }
        backspaceAtStart()
    }

    override func paste(_ sender: Any?) {
        let pasteboard = UIPasteboard.general
        if !pasteboard.hasImages, let text = pasteboard.string, pastesText?(text) == true { return }
        super.paste(sender)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        movedToWindow?(window)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        laidOut?()
    }

    /// Ahead of the text view's own, so Tab nests instead of typing a tab
    /// and ⌘Z undoes through the session. None while marked text is
    /// pending: an IME composition keeps its keys, and a command's commit
    /// would cancel it.
    override var keyCommands: [UIKeyCommand]? {
        guard markedTextRange == nil else { return super.keyCommands }
        let editor = (editorKeys?() ?? []).map { $0.keyCommand(action: #selector(editorKey(_:))) }
        return editor + (super.keyCommands ?? [])
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        for press in presses {
            if let key = press.key { keyWentDown?(key.characters) }
        }
        super.pressesBegan(presses, with: event)
    }

    @objc func editorKey(_ sender: UIKeyCommand) {
        guard let name = sender.propertyList as? String, let command = EditorKeyCommand(rawValue: name) else { return }
        editorKeyPressed?(command)
    }

    /// ⌘Z, the shortcut bar's undo and the undo gestures all reach the
    /// focused text view's undo manager, ahead of any key command: this one
    /// hands them to the session, so they include its block steps.
    let editorUndo = BlockUndoManager()
    override var undoManager: UndoManager? { editorUndo }
    /// The manager the text view's typing is registered in.
    var typingUndo: UndoManager? { super.undoManager }

    /// Drops the typing registered against this text. Once committed it is
    /// a history step, and once redrawn from the core it is not this text's,
    /// so a later typing undo would apply it a second time, coalesced with
    /// newer typing (#4644). UIKit registers typing against the storage.
    func forgetTyping() {
        typingUndo?.removeAllActions(withTarget: textStorage)
    }
}

/// The undo manager a block's text view answers with. `undo()` and
/// `redo()` go through the session (`EditorSession.undo`), which undoes
/// typing first, in `typing`, and its own steps after that.
final class BlockUndoManager: UndoManager {
    /// Where UIKit registers the text view's typing: the manager up the
    /// responder chain, not this one.
    var typing: () -> UndoManager? = { nil }
    var sessionUndo: (() -> Void)?
    var sessionRedo: (() -> Void)?
    var sessionCanUndo: () -> Bool = { false }
    var sessionCanRedo: () -> Bool = { false }

    /// The session's answer once wired (`EditorSession.canUndo`), which
    /// counts typing only where its `undo()` would take it.
    override var canUndo: Bool { sessionUndo == nil ? typing()?.canUndo == true : sessionCanUndo() }
    override var canRedo: Bool { sessionRedo == nil ? typing()?.canRedo == true : sessionCanRedo() }

    override func undo() {
        guard let sessionUndo else { return typing()?.undo() ?? () }
        sessionUndo()
    }

    override func redo() {
        guard let sessionRedo else { return typing()?.redo() ?? () }
        sessionRedo()
    }
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
    var dirty = false {
        didSet { writer = dirty ? session?.model ?? writer : nil }
    }
    /// The page's editor model, held while typing waits for its commit
    /// (#4506). Only the page's `@State` holds it otherwise, and a page torn
    /// down (a split view swapping notes, Back, a size-class re-host) can
    /// free it before this block resigns. It owns `session`, which stays set
    /// for the commit too. The commit's queued write holds it from there.
    private var writer: NoteEditorViewModel?
    /// Typed since the caret came in: a checklist item left with this set is
    /// one desktop's editor would turn into a task.
    var typed = false
    /// The text the user's typing started from: what was last drawn or
    /// committed. While `dirty`, `block` can move on under the text view (a
    /// peer's edit merging in), and a commit sends only the change from
    /// here, so it lands on the live block without deleting the peer's edit.
    var base = ""
    /// The write generation of this row's last write to its block, or the
    /// row's it took over from (`EditorSession.enqueue`). A read older than
    /// it holds the block from before that write (#4738).
    var written = 0
    /// Where the caret goes after the next render (a mark, a chosen link).
    var pendingSelection: NSRange?
    /// Inside `render`, whose `attributedText` puts the caret at the end before
    /// the old selection goes back: the session sees only where it lands.
    private var rendering = false
    /// A render skipped over an IME composition, or a restyle skipped with
    /// an old read, which the next update runs.
    private(set) var stale = false
    /// A wiki link's Open and Open to the Side (#4377).
    private var linkMenu: WikiLinkMenu?

    init(block: Block, session: EditorSession, style: BlockText.Style, alignment: NSTextAlignment) {
        self.block = block
        self.session = session
        self.style = style
        self.alignment = alignment
        super.init()
        let tap = UITapGestureRecognizer(target: self, action: #selector(openTappedTag(_:)))
        tap.delegate = self
        textView.addGestureRecognizer(tap)
        linkMenu = WikiLinkMenu(field: self)
        textView.backspaceAtStart = { [weak self] in
            guard let self else { return }
            self.session?.backspaceAtStart(self)
        }
        textView.movedToWindow = { [weak self] window in
            guard let self else { return }
            self.session?.field(self, movedInto: window)
        }
        textView.laidOut = { [weak self] in
            guard let self, self.session?.field === self else { return }
            self.session?.placeToolbar()
        }
        textView.editorKeys = { [weak self] in
            EditorKeyCommand.active(menuOpen: self?.session?.menuOpen ?? false)
        }
        textView.editorKeyPressed = { [weak self] command in
            self?.session?.perform(command)
        }
        textView.keyWentDown = { [weak self] characters in
            guard let self else { return }
            self.session?.keyWentDown(characters, in: self)
        }
        textView.pastesText = { [weak self] text in
            guard let self else { return false }
            return self.session?.pasteMarkdown(text, in: self) ?? false
        }
        let undo = textView.editorUndo
        undo.typing = { [weak textView] in textView?.typingUndo }
        undo.sessionUndo = { [weak self] in self?.session?.undo() }
        undo.sessionRedo = { [weak self] in self?.session?.redo() }
        undo.sessionCanUndo = { [weak self] in self?.session?.canUndo ?? false }
        undo.sessionCanRedo = { [weak self] in self?.session?.canRedo ?? false }
        installDrops()
    }

    var blockId: String { block.id ?? "" }

    // MARK: Tapping a tag, a date or a wiki link

    /// A tap on a `#tag` opens its notes, as a click on desktop's chip does,
    /// a tap on a wiki link (node or `[[...]]` text) opens its note, as a
    /// click on desktop's link does, and a tap on a date or reminder opens its editor, as a click on
    /// desktop's pill does, instead of putting the caret in it. Begins only
    /// over one of them, so every other tap is the text view's own.
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        let point = gestureRecognizer.location(in: textView)
        if date(at: point) != nil { return true }
        if session?.openWikiTarget != nil, wikiTarget(at: point) != nil { return true }
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
        } else if let target = wikiTarget(at: point) {
            // ⌘-click opens the link beside this pane, as on desktop.
            if gesture.modifierFlags.contains(.command), let side = session?.openWikiTargetToSide {
                side(target)
            } else {
                session?.openWikiTarget?(target)
            }
        } else if let tag = tag(at: point) {
            session?.openTag?(tag)
        }
    }

    private func tag(at point: CGPoint) -> String? {
        attribute(.memryTag, at: point)
    }

    func wikiTarget(at point: CGPoint) -> String? {
        attribute(.memryWikiTarget, at: point)
    }

    private func date(at point: CGPoint) -> DateMentionChip? {
        attribute(.memryDate, at: point)
    }

    /// The `key` value drawn under `point`, if the point is on its glyphs.
    /// Asks the layout for the glyph under the point: `characterRange(at:)`
    /// answers the caret position nearest it, which misses the first half of
    /// a chip (#4154).
    private func attribute<Value>(_ key: NSAttributedString.Key, at point: CGPoint) -> Value? {
        let layout = textView.layoutManager
        let container = textView.textContainer
        let local = CGPoint(x: point.x - textView.textContainerInset.left, y: point.y - textView.textContainerInset.top)
        let glyph = layout.glyphIndex(for: local, in: container)
        guard glyph < layout.numberOfGlyphs,
              layout.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
                  .insetBy(dx: -4, dy: -4).contains(local)
        else { return nil }
        let offset = layout.characterIndexForGlyph(at: glyph)
        guard offset < textView.textStorage.length else { return nil }
        return textView.textStorage.attribute(key, at: offset, effectiveRange: nil) as? Value
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

    /// Takes the page's latest read of the block, and draws it when it or
    /// the row's style changed. **Never over unsaved typing**: re-rendering
    /// resets the text storage, which would move a caret mid-word or drop
    /// what the user typed since the last commit. Nor a read of
    /// `generation`, the writes it includes, older than the row's last
    /// write (`written`): it holds text older than the row's, and drawn, it
    /// put that text back under the caret and the next keys landed inside
    /// it (#4720). A row handed another block takes it. A newer read is
    /// drawn when it differs from the text the row committed too: one equal
    /// to the block the row was drawn from is the core going back to it
    /// (an undo, another pane), not news to skip. Answers whether it
    /// changed.
    @discardableResult
    func receive(_ next: Block, generation: Int, restyled: Bool = false) -> Bool {
        guard next.id != block.id || generation >= written else {
            if restyled { stale = true }
            return false
        }
        let changed = block != next || restyled
        let behind = BlockText.shown(next.inline) != base
        block = next
        if changed { session?.readFocusedBlock(of: self) }
        if changed || stale || behind, !dirty { render() }
        return changed
    }

    /// Draws `block`. Under the caret (a peer pane's or device's edit landing
    /// in the focused block), the keyboard is told the text changed, so it
    /// drops the context it holds: with that context stale, its next keys
    /// replaced the wrong range and deleted bytes (VERIFY-4700). The caret
    /// moves with the text around it. An IME composition is never drawn
    /// over: the render waits for the next update (`stale`).
    func render() {
        guard textView.markedTextRange == nil else {
            stale = true
            return
        }
        stale = false
        let focused = textView.isFirstResponder
        let old = textView.textStorage.string
        let selection = pendingSelection ?? textView.selectedRange
        let mapped = pendingSelection != nil
        pendingSelection = nil
        rendering = true
        if focused {
            textView.inputDelegate?.selectionWillChange(textView)
            textView.inputDelegate?.textWillChange(textView)
        }
        defer {
            rendering = false
            if focused {
                textView.inputDelegate?.textDidChange(textView)
                textView.inputDelegate?.selectionDidChange(textView)
                session?.selectionChanged(in: self)
            }
        }
        let text = NSMutableAttributedString(attributedString: BlockText.attributed(block.inline, style: style))
        if block.kind != "codeBlock" {
            BlockText.markTags(in: text, colors: style.tagColors)
            BlockText.markWikiLinks(in: text, titleExists: style.titleExists)
        }
        textView.useSourceInput(block.kind == "codeBlock")
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        text.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: text.length))
        textView.attributedText = text
        textView.forgetTyping()
        base = text.string
        textView.typingAttributes = BlockText.baseAttributes(style)
        if focused {
            let kept = mapped ? selection : BlockText.carry(selection, from: old, to: text.string)
            let location = min(kept.location, text.length)
            textView.selectedRange = NSRange(location: location, length: min(kept.length, text.length - location))
        }
        textView.invalidateIntrinsicContentSize()
    }

    /// Takes the caret, and what was typed since this row was drawn, from
    /// `old`: the text view this block was edited in before a type change
    /// redrew its row. Its runs are restyled for this row; the next render
    /// draws them from the core.
    private func takeOver(from old: BlockField) {
        typed = typed || old.typed
        // Moving into the window as the old row resigns, this row takes the
        // caret before the old row ends editing, and then never ends editing
        // itself (#5817). The old row commits first, as it does when it ends
        // editing before, so the typing is not left in a row nothing commits.
        if old.dirty {
            session?.returnBurstEnded(in: old)
            old.commitTyping()
        }
        written = max(written, old.written)
        let source = old.textView
        if source.text != textView.text {
            let text = NSMutableAttributedString(attributedString: source.attributedText ?? NSAttributedString())
            let whole = NSRange(location: 0, length: text.length)
            text.enumerateAttribute(.font, in: whole) { value, range, _ in
                if (value as? UIFont) == old.style.font { text.addAttribute(.font, value: style.font, range: range) }
            }
            text.enumerateAttribute(.foregroundColor, in: whole) { value, range, _ in
                if (value as? UIColor) == old.style.ink { text.addAttribute(.foregroundColor, value: style.ink, range: range) }
            }
            textView.attributedText = text
            textView.typingAttributes = BlockText.baseAttributes(style)
            base = old.base
            dirty = old.dirty
            old.dirty = false
            textView.invalidateIntrinsicContentSize()
        }
        let caret = source.selectedRange
        let location = min(caret.location, textView.textStorage.length)
        textView.selectedRange = NSRange(location: location, length: min(caret.length, textView.textStorage.length - location))
    }

    /// Draws each typed `[[target]]` as the link chip the commit turns it
    /// into, keeps the caret on the same text, and takes the result as the
    /// next commit's base: the block the core holds once the link lands.
    /// Answers where a UTF-16 location before the drawing is after it.
    func drawLinks(_ links: [WikiLinkText.Match]) -> (Int) -> Int {
        let caret = textView.selectedRange.location
        var drawn: [(literal: NSRange, chip: Int)] = []
        for link in links.reversed() {
            let attrs = WikiLinkAttrs.attrs(target: link.target, alias: link.alias)
            let run = InlineRun(
                text: "", marks: ["wikiLink"],
                markAttrs: ["wikiLink.target": attrs["target"] ?? link.target, "wikiLink.alias": attrs["alias"] ?? ""],
                target: nil
            )
            let chip = chip(run, at: link.range.location, replacing: (textView.text as NSString).substring(with: link.range))
            textView.textStorage.replaceCharacters(in: link.range, with: chip)
            drawn.append((link.range, chip.length))
        }
        // Each link's range is in the text before any was drawn, so each
        // shifts a location on its own.
        let moved = { (location: Int) -> Int in
            drawn.reduce(location) { moved, link in
                if location >= NSMaxRange(link.literal) { return moved - (link.literal.length - link.chip) }
                if location > link.literal.location { return moved - (location - link.literal.location) + link.chip }
                return moved
            }
        }
        BlockText.markWikiLinks(in: textView.textStorage, titleExists: style.titleExists)
        base = textView.textStorage.string
        textView.selectedRange = NSRange(location: min(moved(caret), textView.textStorage.length), length: 0)
        textView.typingAttributes = BlockText.baseAttributes(style)
        textView.invalidateIntrinsicContentSize()
        return moved
    }

    /// Draws each of `nodes` as its chip, the first at `location` and each
    /// before the space that follows it there, puts the caret after the
    /// last one's space, and takes the result as the next commit's base:
    /// the block the core holds once the nodes land (#4780).
    func drawNodes(_ nodes: [InlineRun], at location: Int) {
        for (offset, run) in nodes.enumerated().reversed() {
            textView.textStorage.insert(chip(run, at: location + offset, replacing: ""), at: location + offset)
        }
        BlockText.markWikiLinks(in: textView.textStorage, titleExists: style.titleExists)
        base = textView.textStorage.string
        textView.selectedRange = NSRange(location: min(location + 2 * nodes.count, textView.textStorage.length), length: 0)
        textView.typingAttributes = BlockText.baseAttributes(style)
        textView.invalidateIntrinsicContentSize()
    }

    /// `run` drawn as its chip, in the paragraph style of the text at
    /// `location`, marked as drawn ahead of the core (`undraw`) with the
    /// text it replaces.
    private func chip(_ run: InlineRun, at location: Int, replacing literal: String) -> NSAttributedString {
        let chip = NSMutableAttributedString(attributedString: BlockText.attributed([run], style: style))
        if location < textView.textStorage.length,
           let paragraph = textView.textStorage.attribute(.paragraphStyle, at: location, effectiveRange: nil) {
            chip.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: chip.length))
        }
        chip.addAttribute(.memryDrawn, value: DrawnChip(draw: Self.draws, literal: literal), range: NSRange(location: 0, length: chip.length))
        return chip
    }

    /// Chips are numbered by the commit that draws them: `draws` is the
    /// number the next chips get until `beginDraw` moves it on.
    private static var draws = 0

    /// Numbers the chips drawn from here on, and answers their number.
    static func beginDraw() -> Int {
        draws += 1
        return draws
    }

    /// Puts back the text each chip of `draws` replaced: a
    /// failed write never gave the core its node, and the row keeps the
    /// typing (REVIEW-4784). The caret stays on the same text.
    func undraw(_ draws: Set<Int>) {
        let storage = textView.textStorage
        var caret = textView.selectedRange.location
        for (range, literal) in Self.chips(of: draws, in: storage).reversed() {
            storage.replaceCharacters(in: range, with: NSAttributedString(string: literal, attributes: BlockText.baseAttributes(style)))
            if caret > range.location { caret += (literal as NSString).length - range.length }
        }
        BlockText.markWikiLinks(in: storage, titleExists: style.titleExists)
        textView.selectedRange = NSRange(location: min(caret, storage.length), length: 0)
        textView.typingAttributes = BlockText.baseAttributes(style)
        textView.invalidateIntrinsicContentSize()
    }

    /// `text` with each chip of `draws` back to the text it replaced: what
    /// a commit queued behind a failed one sends, as the core never got
    /// those nodes (REVIEW-4784).
    static func undrawn(_ text: NSAttributedString, draws: Set<Int>) -> String {
        let string = NSMutableString(string: text.string)
        for (range, literal) in chips(of: draws, in: text).reversed() {
            string.replaceCharacters(in: range, with: literal)
        }
        return string as String
    }

    /// Each chip of `draws` in `text`, in order, and the text it replaced.
    private static func chips(of draws: Set<Int>, in text: NSAttributedString) -> [(range: NSRange, literal: String)] {
        var drawn: [(range: NSRange, literal: String)] = []
        text.enumerateAttribute(.memryDrawn, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            guard let chip = value as? DrawnChip, draws.contains(chip.draw) else { return }
            // Each chip is one character, so adjacent chips are undrawn one by one.
            for location in range.location ..< NSMaxRange(range) {
                drawn.append((NSRange(location: location, length: 1), chip.literal))
            }
        }
        return drawn
    }

    // MARK: UITextViewDelegate

    func textViewDidBeginEditing(_ textView: UITextView) {
        // The old row has resigned by now, so nothing more lands in it.
        if let old = session?.shortcutField {
            session?.shortcutField = nil
            if old !== self, old.blockId == blockId {
                takeOver(from: old)
                session?.returnBurstMoved(to: self)
            }
        }
        session?.focusChanged(to: self)
    }

    /// Committed when editing ends rather than per keystroke: every commit is a
    /// CRDT update and an outbox row (FR-030).
    func textViewDidEndEditing(_ textView: UITextView) {
        session?.returnBurstEnded(in: self)
        commitTyping()
        session?.editingEnded(self, selection: textView.selectedRange)
        if session?.field === self { session?.focusChanged(to: nil) }
    }

    /// Commits the typing, and turns a checklist item typed in into a task,
    /// as desktop's editor does when the caret leaves it.
    func commitTyping() {
        let blockId = blockId
        var then: (@MainActor () async -> Void)?
        if typed, block.kind == "checkListItem", let convert = session?.convertTypedChecklist {
            then = { await convert(blockId) }
        }
        // A row a shortcut is redrawing hands `typed` on (`takeOver`).
        if session?.shortcutField !== self { typed = false }
        session?.commit(self, then: then)
    }

    func textViewDidChange(_ textView: UITextView) {
        dirty = true
        // Typing moved the caret on from any selection a render would put back.
        pendingSelection = nil
        typed = true
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
        if let session, session.dropsLateKeys(text, in: self) { return false }
        // Held for the block a Return is making, as typed (#4692).
        if let session, session.holdsKeys(self), let holds = session.holdsEdit(range, text, in: self) { return holds }
        if let session, session.carriesEdit(range, text, in: self) { return false }
        session?.willType(text, replacing: range, in: self)
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
        // Typing `]` before a `]` that closes an open `[` steps over it, one
        // at a time as desktop's does: a typed `[[Title]]` leaves no `]`.
        if text == "]", range.length == 0, range.location < string.length,
           string.character(at: range.location) == 93 {
            let before = string.substring(to: range.location)
            if before.filter({ $0 == "[" }).count > before.filter({ $0 == "]" }).count {
                textView.selectedRange = NSRange(location: range.location + 1, length: 0)
                return false
            }
        }
        // Return picks an open menu's highlighted row, as Enter does on desktop.
        if text == "\n", let session, session.pickHighlighted() { return false }
        if text == "\n", block.kind != "codeBlock" {
            session?.returnPressed(self)
            return false
        }
        if applyMarkdownShortcut(textView, range: range, text: text) { return false }
        return true
    }

    /// The edit menu over a selection gains a Format submenu: the same marks
    /// the keyboard toolbar's `Aa` panel writes.
    func textView(
        _ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]
    ) -> UIMenu? {
        guard range.length > 0, let session else { return nil }
        return UIMenu(children: [FormatEditMenu.menu(session: session, field: self)] + suggestedActions)
    }
}

extension EditorSession {
    private static let continuingKinds: Set<String> = ["bulletListItem", "numberedListItem", "checkListItem"]

    /// Return, as desktop's Enter: the text after the caret moves to a new
    /// block below (`NoteEditorViewModel.split`), and the caret goes to its
    /// start (#4834). A list item makes another of its kind; any other
    /// block makes a paragraph, except at its start, where the new block
    /// takes its type and props and leaves it empty above (`splitBlockTr`
    /// with `keepType`). An empty list item or heading becomes a paragraph
    /// instead. A selection goes first.
    func returnPressed(_ field: BlockField) {
        let view = field.textView
        let selection = view.selectedRange
        if selection.length > 0 {
            view.textStorage.replaceCharacters(in: selection, with: "")
            view.selectedRange = NSRange(location: selection.location, length: 0)
            field.textViewDidChange(view)
        }
        // A type change still on its way (`turnKeepingCaret`), such as an
        // earlier Return's, is the kind this Return acts on.
        let kind = shortcutField === field ? shortcutKind : field.block.kind
        if view.text.isEmpty, kind != "paragraph" { return turnKeepingCaret(field, into: InsertableBlock.all[0]) }
        guard model != nil else {
            commit(field)
            return
        }
        // After the commit, which can redraw a typed link in `field`.
        commit(field)
        let typed = view.textStorage.string
        let length = view.textStorage.length
        let caret = min(view.selectedRange.location, length)
        let continuing = Self.continuingKinds.contains(kind)
        let pressed = BlockReturn(
            blockId: field.blockId, kind: kind, typed: typed, caret: caret,
            next: continuing ? kind : caret == 0 && length > 0 ? nil : "paragraph",
            // Desktop moves nested blocks with the text after the caret; the
            // core splits no such block, so they keep it, as before #4834,
            // and a new block goes below them.
            nested: hasNestedBlocks(field.blockId),
            // Desktop's `plainByContext`: Return in a plain checklist makes
            // another plain checkbox, never a task.
            plain: kind == "checkListItem" && field.value("plain") == "true"
        )
        var cut: NSAttributedString?
        if !pressed.nested, caret < length {
            let range = NSRange(location: caret, length: length - caret)
            cut = view.textStorage.attributedSubstring(from: range)
            view.textStorage.deleteCharacters(in: range)
            view.selectedRange = NSRange(location: caret, length: 0)
            view.forgetTyping()
            // The block as the core holds it once the split lands; reads
            // from before it are older than `written`.
            field.base = view.textStorage.string
        }
        field.written = enqueue { [weak self] in
            await self?.makeBlock(for: pressed, from: field, cut: cut)
            await self?.didChange()
        }
        startReturnBurst(in: field, makes: pressed.nested ? nil : pressed.next ?? kind, cut: cut)
    }

    func hasNestedBlocks(_ blockId: String) -> Bool {
        let blocks = blocks()
        guard let index = blocks.firstIndex(where: { $0.id == blockId }), index + 1 < blocks.count else { return false }
        return blocks[index + 1].depth > blocks[index].depth
    }

    /// Writes the block `pressed` makes, records it, and hands it the caret
    /// and the keys held for it. A Backspace pressed meanwhile acts on it
    /// first (`backspaceHeld`).
    private func makeBlock(for pressed: BlockReturn, from field: BlockField, cut: NSAttributedString?) async {
        guard let model else { return }
        let blockId = pressed.blockId
        var made: (id: String, step: EditorUndoStep)?
        if pressed.nested {
            let next = pressed.next ?? pressed.kind
            made = await model.insert(next, after: blockId).map { ($0, .insert(blockId: $0, after: blockId, kind: next, text: "")) }
        } else {
            made = await model.split(blockId, typed: pressed.typed, at: pressed.caret, kind: pressed.next)
        }
        guard var made else {
            // A Backspace took the Return back first (`takeBack`): the cut
            // text and `field.base` are already restored.
            guard withdrawnReturn == blockId else { return splitRefused(in: field, putting: cut, typed: pressed.typed) }
            return withdrawnReturn = nil
        }
        if pressed.plain {
            await model.setProp(made.id, "plain", "true")
            made.step.forwardProps = [.setProp(blockId: made.id, name: "plain", value: "true")]
        }
        history.record(made.step)
        if returnBurst?.blockId == blockId, returnBurst?.backspaced == true {
            await turnParagraph(made.id, from: pressed.next ?? pressed.kind)
        }
        if withdrawnReturn == blockId {
            withdrawnReturn = nil
            return await mergeBack(made.id, into: blockId)
        }
        if cut != nil { caretAtStart = made.id }
        returnMade(made.id, from: field)
        focus(made.id)
    }

    /// The core made no block: the text the Return cut from `field` goes
    /// back after whatever was typed there since, and the keys stay there.
    private func splitRefused(in field: BlockField, putting cut: NSAttributedString?, typed: String) {
        if let cut {
            let view = field.textView
            let selection = view.selectedRange
            view.textStorage.append(cut)
            view.selectedRange = selection
            field.base = typed
            field.dirty = view.textStorage.string != typed
        }
        returnRefused(in: field)
    }

    /// The block a Return made goes back into the block it was made from:
    /// a Backspace at its start (#4834).
    func mergeBack(_ newId: String, into blockId: String) async {
        guard let model else { return }
        if let step = await model.merge(newId, into: blockId) { history.record(step) }
    }

    /// The block a Return made turns into a paragraph: a Backspace at its
    /// start, as `backspaceAtStart` does.
    func turnParagraph(_ blockId: String, from kind: String) async {
        guard let model else { return }
        history.record(await model.turnIntoStep(blockId, into: InsertableBlock.all[0], from: kind))
    }

    /// Backspace with the caret at a block's start, in desktop's order
    /// (BlockNote's `handleBackspace`): a block that is not a paragraph turns
    /// into one, a nested paragraph moves out a level, and a paragraph then
    /// joins the block drawn above it, the caret at the join. Above an empty
    /// text block, the empty block goes instead; above a block with no text,
    /// only an empty paragraph goes. Not yet here: a block with nested blocks
    /// (desktop lifts them out) and the first block of a column.
    func backspaceAtStart(_ field: BlockField) {
        if backspaceHeld(in: field) { return }
        keepHeldKeys(in: field)
        if field.block.kind != "paragraph" { return turnInto(InsertableBlock.all[0]) }
        if canOutdent { return nest(false) }
        let blocks = blocks()
        guard let index = blocks.firstIndex(where: { $0.id == field.blockId }), index > 0,
              let previousId = blocks[index - 1].id,
              !NoteColumns.structuralKinds.contains(blocks[index - 1].kind),
              index + 1 == blocks.count || blocks[index + 1].depth <= blocks[index].depth
        else { return }
        let previous = blocks[index - 1]
        let empty = field.textView.textStorage.length == 0
        guard BlockActionTarget.textKinds.contains(previous.kind) else {
            if empty { runner(for: blocks, at: index).delete() }
            return
        }
        if !empty, BlockText.shown(previous.inline).isEmpty {
            return runner(for: blocks, at: index - 1).delete()
        }
        let blockId = field.blockId
        let moved = field.textView.attributedText ?? NSAttributedString()
        commit(field)
        let merged = enqueue { [weak self] in
            guard let self, let model = self.model else { return }
            if let step = await model.merge(blockId, into: previousId) { self.history.record(step) }
            await self.didChange()
        }
        // The caret goes now, so the keyboard stays up.
        guard let above = drawnRow(previousId), above.textView.window != nil else { return focus(previousId) }
        join(moved, from: field, into: above, merged: merged)
    }

    /// Draws the merge of `field` into `above` before it lands, with the
    /// caret at the join. Until the merge (`merged`) lands, `above`'s text
    /// is the block's: keys typed meanwhile go at the join, and no read from
    /// before the merge is drawn over it (`written`). Drawn only once the
    /// merge redrew it, the row showed its own text with the caret at its
    /// end, and keys typed there went after the merged text (VERIFY-5122).
    private func join(_ moved: NSAttributedString, from field: BlockField, into above: BlockField, merged: Int) {
        let text = NSMutableAttributedString(attributedString: moved)
        let whole = NSRange(location: 0, length: text.length)
        text.enumerateAttribute(.font, in: whole) { value, range, _ in
            if (value as? UIFont) == field.style.font { text.addAttribute(.font, value: above.style.font, range: range) }
        }
        text.enumerateAttribute(.foregroundColor, in: whole) { value, range, _ in
            if (value as? UIColor) == field.style.ink { text.addAttribute(.foregroundColor, value: above.style.ink, range: range) }
        }
        let view = above.textView
        let join = view.textStorage.length
        view.textStorage.append(text)
        view.forgetTyping()
        above.base += moved.string
        above.written = max(above.written, merged)
        view.selectedRange = NSRange(location: join, length: 0)
        takeCaret(above, atEnd: false)
    }

    private func runner(for blocks: [Block], at index: Int) -> BlockActionRunner {
        BlockActionRunner(
            session: self, target: BlockActionTarget(block: blocks[index], siblings: BlockSiblings.of(index, in: blocks))
        )
    }
}

/// A Return as pressed: what `EditorSession.makeBlock` writes once the
/// typing before it lands.
private struct BlockReturn {
    let blockId: String
    let kind: String
    /// The block's text as the pane showed it, and the caret in it (UTF-16).
    let typed: String
    let caret: Int
    /// The new block's kind; `nil`: the block's own kind and props.
    let next: String?
    /// The block has nested blocks: a new block goes below them instead.
    let nested: Bool
    let plain: Bool
}

/// A chip drawn ahead of the core, and the text it replaced (`undraw`).
private struct DrawnChip {
    let draw: Int
    let literal: String
}

private extension NSAttributedString.Key {
    static let memryDrawn = NSAttributedString.Key("memry.drawn")
}
