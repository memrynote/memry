//
//  EditorSession.swift
//  The page-wide editing state behind the keyboard toolbar: which block has
//  the caret, which panel is open, the `[[` / `@` menu, undo, and every
//  toolbar action, applied in order through `NoteEditorViewModel`.
//
//  One per editor model, so the note page and the journal day page share it
//  through `NotePageContent` without either owning a toolbar of its own.
//

import MemryCore
import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class EditorSession {
    enum Panel: Equatable {
        case none
        /// The `+` grid: `BlockCatalog`, desktop's slash menu.
        case insert
        /// The block chip: turn into, and the block's own colours.
        case block
    }

    // MARK: Wiring

    @ObservationIgnored weak var model: NoteEditorViewModel?
    @ObservationIgnored var didChange: () async -> Void = {}
    /// Titles for the `[[` and `@` menus, most recently modified first.
    @ObservationIgnored var titles: [String] = []
    /// Each note's emoji by lowercased title, for the `[[` / `@` rows.
    @ObservationIgnored var icons: [String: String] = [:]
    @ObservationIgnored var titleExists: ((String) -> Bool)?
    /// Every vault tag, most used first, for the `#` menu.
    @ObservationIgnored var tags: [String] = []
    /// Each tag's chosen colour by lowercased name, for the `hashTag` node.
    @ObservationIgnored var tagColors: [String: String] = [:]
    /// Opens an attachment picker; `nil` hides the paperclip menu and the
    /// catalog's media rows.
    var attach: ((EditorAttachmentSource) -> Void)?
    /// The page's blocks, flat with `depth`, as the page draws them: what the
    /// toolbar's indent and move buttons read the focused block's place from.
    /// Read through the page's observable model, so the toolbar redraws when
    /// the body does.
    @ObservationIgnored var blocks: () -> [Block] = { [] }
    /// Points a moved task line's task at its new note: task id, target note.
    @ObservationIgnored var relinkTask: ((String, String) async -> Void)?
    /// Opens a tag's notes, for a tap on a `#tag` in a block. `nil` leaves the
    /// tap to place the caret, as on a page with no stack to push onto.
    @ObservationIgnored var openTag: ((String) -> Void)?
    /// Schedules a vault sync pass (`requestVaultSync`), so a write reaches
    /// other devices without waiting for the next foreground or launch.
    @ObservationIgnored var requestSync: (@MainActor () -> Void)?

    // MARK: State the toolbar draws

    private(set) var panel: Panel = .none
    /// The block with the caret.
    private(set) var focusedKind: String?
    /// Its id, observed so the block can draw its action handle.
    private(set) var focusedBlockId: String?
    private(set) var focusedLevel: Int?
    private(set) var focusedProps: [String: String] = [:]
    /// Marks every character of the selection carries.
    private(set) var selectionMarks: Set<String> = []
    private(set) var hasSelection = false
    private(set) var trigger: InlineTrigger?
    private(set) var suggestions: [EditorSuggestion] = []
    /// The open `#` menu, when no `[[` / `@` menu is.
    private(set) var tagTrigger: HashTagTrigger?
    private(set) var tagSuggestions: [TagSuggestion] = []
    /// The toolbar shows the format slide (`Aa`) rather than the main row.
    private(set) var formatting = false
    /// A block waiting for the note picker (the `...` menu's Move to).
    private(set) var moveRequest: BlockMoveRequest?
    /// Why the last Move to did not land, for the page's alert.
    var moveFailure: UserFacingError?
    /// A tapped date chip whose editor is open.
    private(set) var dateEdit: DateMentionEditRequest?
    /// The block that chip is in, which need not have the caret.
    @ObservationIgnored private weak var dateEditField: BlockField?
    private(set) var linkRequest: LinkBlockRequest?
    /// A block whose source sheet is open (`BlockSourceSheet`).
    private(set) var sourceEdit: BlockSourceRequest?
    let history = EditorUndoStack()

    @ObservationIgnored weak var field: BlockField?
    /// A block to put the caret in once it is drawn.
    @ObservationIgnored var pendingFocus: String?
    @ObservationIgnored var keyboardHeight: CGFloat = 300
    @ObservationIgnored private var tail: Task<Void, Never>?
    // `nonisolated(unsafe)`: written once in `init`, read only by `deinit`,
    // which runs after the last reference is gone.
    @ObservationIgnored private nonisolated(unsafe) var keyboardObserver: NSObjectProtocol?

    init() {
        keyboardObserver = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            MainActor.assumeIsolated {
                guard let self, self.panel == .none else { return }
                let accessory = self.accessory.frame.height
                if frame.height - accessory > 200 { self.keyboardHeight = frame.height - accessory }
            }
        }
    }

    deinit {
        if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }
    }

    // MARK: Input views

    @ObservationIgnored lazy var accessory: UIView = floatingAccessory(EditorKeyboardToolbar(session: self))
    @ObservationIgnored private lazy var panelView: UIInputView = host(EditorPanelView(session: self), height: keyboardHeight)

    private func host<Content: View>(_ content: Content, height: CGFloat?) -> UIInputView {
        let input = UIInputView(
            frame: CGRect(x: 0, y: 0, width: 320, height: height ?? Tokens.Size.minimumHitArea + Tokens.Space.small),
            inputViewStyle: .keyboard
        )
        input.allowsSelfSizing = true
        input.autoresizingMask = [.flexibleWidth]
        input.translatesAutoresizingMaskIntoConstraints = height != nil
        let hosting = UIHostingController(rootView: content)
        hosting.sizingOptions = height == nil ? .intrinsicContentSize : []
        hosting.view.backgroundColor = .clear
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        input.addSubview(hosting.view)
        NSLayoutConstraint.activate([
            hosting.view.leadingAnchor.constraint(equalTo: input.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: input.trailingAnchor),
            hosting.view.topAnchor.constraint(equalTo: input.topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: input.bottomAnchor),
        ])
        objc_setAssociatedObject(input, &Self.hostingKey, hosting, .OBJC_ASSOCIATION_RETAIN)
        return input
    }

    /// A plain clear view, not a `.keyboard` `UIInputView`: on iOS 26 that
    /// style paints its own soft blur band above the accessory, which reads as
    /// a shadow over the note behind the glass toolbar.
    private func floatingAccessory<Content: View>(_ content: Content) -> UIView {
        let hosting = UIHostingController(rootView: content)
        hosting.sizingOptions = .intrinsicContentSize
        hosting.view.backgroundColor = .clear
        let view = hosting.view ?? UIView()
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        objc_setAssociatedObject(view, &Self.hostingKey, hosting, .OBJC_ASSOCIATION_RETAIN)
        return view
    }

    nonisolated(unsafe) private static var hostingKey: UInt8 = 0

    func show(_ next: Panel) {
        panel = panel == next ? .none : next
        guard let textView = field?.textView else { return }
        if panel == .none {
            textView.inputView = nil
        } else {
            panelView.frame.size.height = keyboardHeight
            textView.inputView = panelView
        }
        textView.reloadInputViews()
    }

    // MARK: Focus and selection

    func focusChanged(to field: BlockField?) {
        focusedBlockId = field?.blockId
        if let field {
            self.field = field
            focusedKind = field.block.kind
            focusedLevel = field.value("level").flatMap(Int.init)
            focusedProps = Dictionary(field.block.props.map { ($0.name, $0.value) }) { $1 }
            selectionChanged(in: field)
        } else {
            if panel != .none { panel = .none }
            formatting = false
            trigger = nil
            suggestions = []
            tagTrigger = nil
            tagSuggestions = []
        }
    }

    func selectionChanged(in field: BlockField) {
        guard field === self.field else { return }
        let textView = field.textView
        let range = textView.selectedRange
        let selected = range.length > 0
        // Selecting brings up the format slide, and collapsing the selection
        // takes it away again; `Aa` and its back chevron switch it by hand.
        if selected != hasSelection { formatting = selected }
        hasSelection = selected
        var marks: Set<String>?
        if range.length > 0 {
            textView.attributedText.enumerateAttribute(.memryMarks, in: range) { value, _, _ in
                let here = Set(value as? [String] ?? [])
                marks = marks.map { $0.intersection(here) } ?? here
            }
        }
        selectionMarks = marks ?? []
        // A code block keeps `[[`, `@`, `/` and `#` as literal text, as
        // desktop's does: no menu opens there.
        let inCode = field.block.kind == "codeBlock"
        let next = range.length == 0 && !inCode ? InlineTrigger.active(in: textView.text, caret: range.location) : nil
        if next != trigger {
            let leftWiki: Bool = if case .wiki = trigger { next == nil } else { false }
            trigger = next
            suggestions = switch next {
            case let .wiki(_, query): EditorSuggestions.wiki(query: query, titles: titles)
            case let .mention(_, query): EditorSuggestions.mention(query: query, titles: titles)
            case let .slash(_, query): slashSuggestions(query: query)
            case nil: []
            }
            // A `@` query nothing answers closes the menu, as desktop's does.
            if case .mention = next, suggestions.isEmpty { trigger = nil }
            if case .slash = next, suggestions.isEmpty { trigger = nil }
            // The caret left a finished `[[target]]`: it becomes a link.
            if leftWiki, !WikiLinkText.typed(in: textView.text, since: field.base).isEmpty { commit(field) }
        }
        let nextTag = range.length == 0 && trigger == nil && !inCode
            ? HashTagTrigger.active(in: textView.text, caret: range.location) : nil
        if nextTag != tagTrigger {
            tagTrigger = nextTag
            tagSuggestions = nextTag.map { TagSuggestions.rank(query: $0.query, tags: tags) } ?? []
            if tagSuggestions.isEmpty { tagTrigger = nil }
        }
    }

    // MARK: Ordered writes

    /// Runs `work` after every write queued before it: a mark must land after
    /// the commit of the text it marks.
    private func enqueue(_ work: @escaping @MainActor () async -> Void) {
        let previous = tail
        tail = Task { @MainActor in
            await previous?.value
            await work()
        }
    }

    /// Writes what the user typed in `field`, then turns a `[[target]]` typed
    /// since the last commit into a link node (desktop's input rule). Never
    /// in a code block, whose text stays literal.
    func commit(_ field: BlockField, then: (@MainActor () async -> Void)? = nil) {
        let attributed = field.textView.attributedText ?? NSAttributedString()
        let text = attributed.string
        let current = BlockText.shown(field.block.inline)
        let formatted = BlockText.isFormatted(field.block.inline) || text.contains(BlockText.placeholder)
        let blockId = field.blockId
        let dirty = field.dirty
        let base = field.base
        let links = dirty && field.block.kind != "codeBlock" ? WikiLinkText.typed(in: text, since: base) : []
        let offsets = links.map { (
            BlockText.coreOffset(in: attributed, utf16: $0.range.location),
            BlockText.coreOffset(in: attributed, utf16: NSMaxRange($0.range)),
            $0
        ) }
        field.dirty = false
        if dirty { field.base = text }
        // The literal text goes now, not when the page reloads: typing that
        // lands before the reload would keep it, and the next commit's base
        // would still spell a link the core already holds as a node.
        if !links.isEmpty { field.drawLinks(links) }
        enqueue { [weak self] in
            guard let self, let model = self.model else { return }
            if dirty, text != base {
                await model.commit(text, for: blockId, current: current, formatted: formatted, base: base)
                self.history.record(Self.textStep(blockId, from: current, to: text, formatted: formatted))
            }
            for (start, end, link) in offsets.reversed() {
                await model.insertWikiLink(in: blockId, from: start, to: end, title: link.target, alias: link.alias)
            }
            await then?()
            if dirty || !offsets.isEmpty || then != nil { await self.didChange() }
        }
    }

    private static func textStep(_ blockId: String, from: String, to: String, formatted: Bool) -> EditorUndoStep {
        formatted
            ? .replaceText(blockId: blockId, from: from, to: to)
            : .text(blockId: blockId, from: from, to: to)
    }

    /// Commits the focused block (if any), then runs `work` against it.
    private func withFocused(_ work: @escaping @MainActor (NoteEditorViewModel, String) async -> Void) {
        guard let field else { return }
        let blockId = field.blockId
        commit(field) { [weak self] in
            guard let model = self?.model else { return }
            await work(model, blockId)
        }
    }

    // MARK: Blocks

    func turnInto(_ block: InsertableBlock) {
        withFocused { [weak self] model, blockId in
            await self?.turn(model, blockId, into: block)
        }
    }

    private func turn(_ model: NoteEditorViewModel, _ blockId: String, into block: InsertableBlock) async {
        let previous = focusedKind ?? "paragraph"
        history.record(await model.turnIntoStep(blockId, into: block, from: previous))
        focusedKind = block.id
        focusedLevel = block.level
    }

    /// `textColor` or `backgroundColor` on the block itself, as desktop's
    /// side-menu colour picker writes them.
    func setBlockColor(_ prop: String, _ name: String) {
        let previous = focusedProps[prop] ?? "default"
        focusedProps[prop] = name
        withFocused { [weak self] model, blockId in
            await model.setProp(blockId, prop, name)
            self?.history.record(.prop(blockId: blockId, name: prop, from: previous, to: name, label: "Colour"))
        }
    }

    // MARK: Marks

    /// Toggles a boolean mark, or sets a valued one, over the selection.
    func toggleMark(_ mark: String, value: String? = nil) {
        guard let field else { return }
        let range = field.textView.selectedRange
        guard range.length > 0 else { return }
        let text = field.textView.attributedText ?? NSAttributedString()
        let start = BlockText.coreOffset(in: text, utf16: range.location)
        let end = BlockText.coreOffset(in: text, utf16: NSMaxRange(range))
        let removing = value == nil && selectionMarks.contains(mark) || value == "default"
        // What undo puts back: a plain mark carries no value, and a valued
        // one's value is read from the drawn block, when the selection holds
        // one value throughout. Otherwise the removal is not undoable here.
        let restore: String?? = if !removing {
            nil
        } else if !Self.valuedMarks.contains(mark) {
            selectionMarks.contains(mark) ? .some(nil) : nil
        } else if !field.dirty {
            Self.markValue(mark, in: field.block.inline, from: start, to: end)
        } else {
            nil
        }
        field.pendingSelection = range
        withFocused { [weak self] model, blockId in
            if removing {
                await model.unmark(blockId, from: start, to: end, mark)
                if case let .some(previous) = restore {
                    let lower = UInt32(max(0, start))
                    let upper = UInt32(max(0, end))
                    self?.history.record(EditorUndoStep(
                        name: "Formatting",
                        backward: .setMark(blockId: blockId, start: lower, end: upper, mark: mark, value: previous),
                        forward: .removeMark(blockId: blockId, start: lower, end: upper, mark: mark)
                    ))
                }
            } else {
                await model.mark(blockId, from: start, to: end, mark, value: value)
                self?.history.record(.mark(blockId: blockId, start: start, end: end, mark: mark, value: value))
            }
        }
    }

    /// Marks whose value is part of what they say.
    private static let valuedMarks: Set<String> = ["textColor", "backgroundColor", "link"]

    /// The value `mark` holds over every core byte of `start..<end`: `nil`
    /// when a byte lacks the mark or the values differ, `.some(nil)` for a
    /// mark with no value.
    static func markValue(_ mark: String, in runs: [InlineRun], from start: Int, to end: Int) -> String?? {
        var values = Set<String?>()
        var offset = 0
        for run in runs {
            let length = run.text.utf8.count
            defer { offset += length }
            guard length > 0, offset < end, offset + length > start else { continue }
            guard run.marks.contains(mark) else { return nil }
            values.insert(run.markAttrs[mark])
        }
        return values.count == 1 ? values.first : nil
    }

    // MARK: Inline nodes

    /// The slash menu's link row: `[[]]` with the caret between, which opens
    /// the menu.
    func startWikiLink() {
        guard let textView = field?.textView else { return }
        show(.none)
        textView.insertText("[[]]")
        let caret = textView.selectedRange.location
        textView.selectedRange = NSRange(location: max(0, caret - 2), length: 0)
        if let field { selectionChanged(in: field) }
    }

    /// The `@` and `#` buttons: the trigger at the caret, after a space when
    /// the caret ends a word, so the menu opens as if typed.
    func startTrigger(_ character: String) {
        guard let field else { return }
        let textView = field.textView
        show(.none)
        let caret = textView.selectedRange.location
        let string = textView.text as NSString
        let before = caret > 0 && caret <= string.length ? string.character(at: caret - 1) : 32
        let wordEnds = before != 32 && before != 9 && before != 10 && before != 0xA0 && before != 0xFFFC
        textView.insertText(wordEnds ? " " + character : character)
        selectionChanged(in: field)
    }

    /// Replaces the open `#query` with a `hashTag` node and a space, as
    /// desktop's tag menu does.
    func chooseTag(_ suggestion: TagSuggestion) {
        guard let field, let tagTrigger else { return }
        let textView = field.textView
        let range = tagTrigger.range
        let after = NSMaxRange(range)
        let string = textView.text as NSString
        if after >= string.length || string.character(at: after) != 32 {
            textView.textStorage.insert(
                NSAttributedString(string: " ", attributes: BlockText.baseAttributes(field.style)), at: after
            )
            field.dirty = true
        }
        let attributed = textView.attributedText ?? NSAttributedString()
        let start = BlockText.coreOffset(in: attributed, utf16: range.location)
        let end = BlockText.coreOffset(in: attributed, utf16: after)
        field.pendingSelection = NSRange(location: range.location + 2, length: 0)
        self.tagTrigger = nil
        tagSuggestions = []
        let attrs = HashTagAttrs.attrs(tag: suggestion.tag, colors: tagColors)
        withFocused { model, blockId in
            await model.insertInline(blockId, from: start, to: end, kind: "hashTag", text: "", attrs: attrs)
        }
    }

    // MARK: The focused block's place

    /// The block with the caret, as the page last drew it.
    var focusedBlock: Block? {
        guard let focusedBlockId else { return nil }
        return blocks().first { $0.id == focusedBlockId }
    }

    /// Its neighbours at its own depth, which Move up and Move down swap it
    /// with and indent nests it under.
    var focusedSiblings: BlockSiblings {
        let blocks = blocks()
        guard let focusedBlockId, let index = blocks.firstIndex(where: { $0.id == focusedBlockId }) else {
            return BlockSiblings()
        }
        return BlockSiblings.of(index, in: blocks)
    }

    /// The core nests any block under its previous sibling, and refuses the
    /// first block of its parent (`indent` in `structure.rs`).
    var canIndent: Bool { focusedSiblings.previous != nil }
    /// The core lifts any nested block, and refuses a top-level one.
    var canOutdent: Bool { (focusedBlock?.depth ?? 0) > 0 }

    /// The block menu's actions for the focused block.
    var focusedRunner: BlockActionRunner? {
        guard let block = focusedBlock else { return nil }
        return BlockActionRunner(session: self, target: BlockActionTarget(block: block, siblings: focusedSiblings))
    }

    /// The toolbar's items for the focused block.
    var toolbarItems: [EditorToolbarItem] { EditorToolbarItem.order(for: focusedKind) }

    func showFormatting(_ on: Bool) {
        formatting = on
    }

    /// The `...` menu's Copy text: the block's text, inline nodes as they read.
    func copyFocusedText() {
        guard let field else { return }
        UIPasteboard.general.string = field.dirty
            ? field.textView.text.replacingOccurrences(of: BlockText.placeholder, with: "")
            : Self.plainText(field.block.inline)
    }

    static func plainText(_ runs: [InlineRun]) -> String {
        runs.map(\.text).joined()
    }

    // MARK: Move to another note

    /// Desktop hides Move to on a block that owns an attachment
    /// (`ATTACHMENT_BLOCK_TYPES` and `carriesAttachment` in
    /// `block-side-menu.tsx`): the bytes live under the owning note, and the
    /// embed would break on every other device. The nested blocks move too,
    /// so they are checked as well.
    static let attachmentKinds: Set<String> = ["file", "image", "video", "audio"]

    static func carriesAttachment(at index: Int, in blocks: [Block]) -> Bool {
        subtree(at: index, in: blocks).contains { block in
            attachmentKinds.contains(block.kind) || block.inline.contains { $0.marks.contains("inlineImage") }
        }
    }

    /// The block at `index` and every block nested under it.
    static func subtree(at index: Int, in blocks: [Block]) -> ArraySlice<Block> {
        guard blocks.indices.contains(index) else { return [] }
        let depth = blocks[index].depth
        let end = blocks[(index + 1)...].firstIndex { $0.depth <= depth } ?? blocks.endIndex
        return blocks[index..<end]
    }

    /// Task ids of the task lines that move with the block at `index`
    /// (desktop's `taskIdsInBlocks`).
    static func taskIds(at index: Int, in blocks: [Block]) -> [String] {
        subtree(at: index, in: blocks).compactMap { block in
            guard block.kind == "taskBlock",
                  let id = block.props.first(where: { $0.name == "taskId" })?.value, !id.isEmpty else { return nil }
            return id
        }
    }

    var canMoveToNote: Bool {
        guard model?.canMoveBlocks == true, let focusedBlockId else { return false }
        let blocks = blocks()
        guard let index = blocks.firstIndex(where: { $0.id == focusedBlockId }) else { return false }
        return !Self.carriesAttachment(at: index, in: blocks)
    }

    /// The `...` menu's Move to: the keyboard goes first, so the block's
    /// typing is committed before the picker opens.
    func requestMoveToNote() {
        guard let focusedBlockId else { return }
        dismissKeyboard()
        moveRequest = BlockMoveRequest(blockId: focusedBlockId)
    }

    func cancelMoveToNote() {
        moveRequest = nil
    }

    // MARK: Dates

    /// Opens the editor for a tapped date or reminder chip.
    func requestDateEdit(_ chip: DateMentionChip, in field: BlockField) {
        dismissKeyboard()
        dateEditField = field
        dateEdit = DateMentionEditRequest(blockId: field.blockId, anchorId: chip.anchorId, value: chip.value)
    }

    func cancelDateEdit() {
        dateEdit = nil
        dateEditField = nil
    }

    /// Rewrites the open chip. The chip's character is swapped in the text
    /// view and committed like typing (a space for an update, the date's
    /// words for a conversion, nothing for a removal); an update then puts
    /// the node back over that space under the same anchor, the path a typed
    /// `[[link]]` takes. The space keeps the insert inside a text run even
    /// when the chip was the block's only content.
    func applyDateEdit(_ edit: DateMentionEdit) {
        guard let request = dateEdit, let field = dateEditField, field.blockId == request.blockId,
              let range = field.dateChipRange(anchorId: request.anchorId)
        else { return cancelDateEdit() }
        cancelDateEdit()
        let replacement = switch edit {
        case .update: " "
        case .convertToText: DateMentionRemind.plainText(request.value)
        case .remove: ""
        }
        let attributes = BlockText.baseAttributes(field.style)
        field.textView.textStorage.replaceCharacters(
            in: range, with: NSAttributedString(string: replacement, attributes: attributes)
        )
        field.dirty = true
        guard case let .update(value) = edit else { return commit(field) }
        let attributed = field.textView.attributedText ?? NSAttributedString()
        let start = BlockText.coreOffset(in: attributed, utf16: range.location)
        let blockId = field.blockId
        commit(field) { [weak self] in
            await self?.model?.insertDateMention(
                in: blockId, from: start, to: start + 1, value: value, anchorId: request.anchorId
            )
        }
    }

    // MARK: Source blocks

    /// Opens the source sheet for a math block.
    func editSource(_ request: BlockSourceRequest) {
        dismissKeyboard()
        sourceEdit = request
    }

    func cancelSourceEdit() {
        sourceEdit = nil
    }

    /// The sheet's Done: the source is written once, as desktop writes it
    /// when its popover closes, and only when it changed.
    func saveSource(_ text: String) {
        guard let request = sourceEdit else { return }
        sourceEdit = nil
        guard text != request.source else { return }
        runBlockAction { [weak self] model in
            await model.setProp(request.blockId, "latex", text)
            self?.history.record(.prop(
                blockId: request.blockId, name: "latex", from: request.source, to: text, label: "Equation"
            ))
            self?.requestSync?()
        }
    }

    /// Moves the requested block to the end of `targetId`'s body, after every
    /// queued write. Not undoable here: the block now lives in another note.
    func moveToNote(_ targetId: String) {
        guard let request = moveRequest else { return }
        moveRequest = nil
        enqueue { [weak self] in
            guard let self, let model = self.model else { return }
            let blocks = self.blocks()
            let taskIds = blocks.firstIndex { $0.id == request.blockId }
                .map { Self.taskIds(at: $0, in: blocks) } ?? []
            if let failure = await model.moveBlock(request.blockId, toNote: targetId) {
                self.moveFailure = failure
            } else if let relink = self.relinkTask {
                for taskId in taskIds { await relink(taskId, targetId) }
            }
            await self.didChange()
        }
    }

    // MARK: Nesting and attachments

    /// Nests the caret's block under its previous sibling (`true`), or lifts
    /// it out a level; the core refuses an indent with nothing to nest under.
    func nest(_ indent: Bool) {
        withFocused { [weak self] model, blockId in
            let forward: BlockEdit = indent ? .indent(blockId: blockId) : .outdent(blockId: blockId)
            let backward: BlockEdit = indent ? .outdent(blockId: blockId) : .indent(blockId: blockId)
            await model.apply(forward)
            self?.history.record(EditorUndoStep(name: indent ? "Indent" : "Outdent", backward: backward, forward: forward))
            self?.pendingFocus = blockId
        }
    }

    /// Opens an attachment picker once the open block's typing is written.
    /// That write ends in a page reload, which would tear down a picker
    /// already on screen.
    func openAttachment(_ source: EditorAttachmentSource) {
        guard let attach else { return }
        if let field { commit(field) }
        enqueue { attach(source) }
    }

    /// The link sheet for a Bookmark or YouTube row, for a block after the
    /// caret's. The keyboard goes first, so the block's typing is committed.
    func requestLink(_ kind: LinkBlock.Kind) {
        linkRequest = LinkBlockRequest(kind: kind, after: field?.blockId)
        if let field { commit(field) }
        dismissKeyboard()
    }

    func cancelLink() {
        linkRequest = nil
    }

    func insertLink(_ block: LinkBlock) {
        guard let request = linkRequest else { return }
        linkRequest = nil
        enqueue { [weak self] in
            guard let self, let model = self.model,
                  let newId = await model.insert(block.kind, after: request.after) else { return }
            let edits = block.edits(newId: newId, after: request.after)
            for edit in edits.dropFirst() { await model.apply(edit) }
            self.history.record(EditorUndoStep(
                name: "Insert block", backward: .delete(blockId: newId), forward: edits[0], forwardProps: Array(edits.dropFirst())
            ))
            await self.didChange()
        }
    }

    /// An uploaded attachment's block, after the caret's block (or at the end
    /// of the body when none has had the caret). Undo removes the block and
    /// keeps the upload, as desktop's undo does.
    func insertAttachment(_ block: AttachmentBlock) {
        let after = field?.blockId
        if let field { commit(field) }
        enqueue { [weak self] in
            guard let self, let model = self.model else { return }
            guard let newId = await model.insert(block.kind, after: after) else { return }
            let props = block.props.map { BlockEdit.setProp(blockId: newId, name: $0.name, value: $0.value) }
            for prop in props { await model.apply(prop) }
            var step = EditorUndoStep.insert(blockId: newId, after: after, kind: block.kind, text: "")
            step.forwardProps = props
            self.history.record(step)
            await self.didChange()
        }
    }

    /// Replaces the open `[[` / `@` text with the chosen node and a space,
    /// as desktop's menus insert it.
    func choose(_ suggestion: EditorSuggestion) {
        if case let .slash(row) = suggestion.kind { return chooseSlash(row) }
        guard let trigger else { return }
        insertInline(suggestion.kind, replacing: trigger.range)
    }

    /// `range` of the focused block replaced with a link or date node and a
    /// space.
    func insertInline(_ kind: EditorSuggestion.Kind, replacing range: NSRange) {
        guard let field else { return }
        let textView = field.textView
        // The trailing space goes in as text first, so the node lands before it.
        let after = NSMaxRange(range)
        let string = textView.text as NSString
        if after >= string.length || string.character(at: after) != 32 {
            textView.textStorage.insert(
                NSAttributedString(string: " ", attributes: BlockText.baseAttributes(field.style)), at: after
            )
            field.dirty = true
        }
        let attributed = textView.attributedText ?? NSAttributedString()
        let start = BlockText.coreOffset(in: attributed, utf16: range.location)
        let end = BlockText.coreOffset(in: attributed, utf16: after)
        field.pendingSelection = NSRange(location: range.location + 2, length: 0)
        self.trigger = nil
        suggestions = []
        withFocused { model, blockId in
            switch kind {
            case let .note(title, alias), let .create(title, alias):
                await model.insertWikiLink(in: blockId, from: start, to: end, title: title, alias: alias)
            case let .date(value):
                await model.insertDateMention(in: blockId, from: start, to: end, value: value)
            case .slash:
                break
            }
        }
    }

    /// A link or date at the end of `block`, followed by a space: the page
    /// menu's path, for when no block has the caret.
    func append(_ kind: EditorSuggestion.Kind, to block: Block) {
        guard let blockId = block.id else { return }
        let shown = BlockText.shown(block.inline)
        let end = block.inline.reduce(0) { $0 + $1.text.utf8.count }
        enqueue { [weak self] in
            guard let self, let model = self.model else { return }
            // The space first, so the node lands inside a text run.
            await model.commit(shown + " ", for: blockId, current: shown, formatted: true)
            switch kind {
            case let .note(title, alias), let .create(title, alias):
                await model.insertWikiLink(in: blockId, from: end, to: end, title: title, alias: alias)
            case let .date(value):
                await model.insertDateMention(in: blockId, from: end, to: end, value: value)
            case .slash:
                break
            }
            await self.didChange()
        }
    }

    // MARK: Undo

    var canUndo: Bool { history.canUndo || (field?.textView.undoManager?.canUndo ?? false) }
    var canRedo: Bool { history.canRedo || (field?.textView.undoManager?.canRedo ?? false) }

    /// Typing in the open block first, through the text view's own undo;
    /// then the writes this session made, newest first.
    func undo() {
        if let undoManager = field?.textView.undoManager, undoManager.canUndo, field?.dirty == true {
            undoManager.undo()
            return
        }
        guard let step = history.popUndo() else { return }
        replay([step.backward])
    }

    func redo() {
        if let undoManager = field?.textView.undoManager, undoManager.canRedo, field?.dirty == true {
            undoManager.redo()
            return
        }
        guard let step = history.popRedo() else { return }
        replay([step.forward] + step.forwardProps)
    }

    private func replay(_ edits: [BlockEdit]) {
        if let field { field.dirty = false }
        enqueue { [weak self] in
            guard let self, let model = self.model else { return }
            for edit in edits { await model.apply(edit) }
            await self.didChange()
        }
    }

    /// A block action (`BlockActions.swift`): after every queued write, the
    /// open block's typing first, then the page reloads.
    func runBlockAction(_ work: @escaping @MainActor (NoteEditorViewModel) async -> Void) {
        if let field { commit(field) }
        enqueue { [weak self] in
            guard let self, let model = self.model else { return }
            await work(model)
            await self.didChange()
        }
    }

    func dismissKeyboard() {
        if panel != .none { show(.none) }
        field?.textView.resignFirstResponder()
    }
}

/// A block the note picker is open for.
struct BlockMoveRequest: Identifiable, Equatable {
    let blockId: String
    var id: String { blockId }
}
