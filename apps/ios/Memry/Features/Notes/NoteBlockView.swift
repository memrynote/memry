import MemryCore
import SwiftUI
import UIKit

// The note body, rendered from the core's blocks.
//
// **This replaces a preview, not an editor.** Until now the body was
// `extract_text` output: headings arrived as `# `, bullets as `- `, and marks,
// links and callout types arrived as nothing at all. `Notes.blocks(id:)` hands
// over the shape instead, and this file draws it with the platform's own type
// system — `Text`, `AttributedString`, SF Symbols. No web view, no markdown
// parser, no second document model.
//
// **An unknown block is drawn, never dropped.** A block type this build has
// never heard of arrives with its tag and its text, and renders as a paragraph.
// Dropping it would lose a user's writing to a version skew, which is the one
// failure this whole path exists to avoid.
//
// **Typography is `DESIGN.md`'s, not Paper's.** The body is the working sans:
// the document maps sans to "body text and the BlockNote editor" and reserves
// the serif for journal and reflective copy, and its anti-pattern list rejects
// large serif on dense operational screens. Only the mono roles are special —
// code blocks are read character by character.

struct NoteBlocksView: View {
    let blocks: [Block]
    /// Where a wiki link goes when it is tapped. `nil` while nothing can
    /// resolve one, which is honest: a link that looks tappable and does
    /// nothing is worse than a link that does not look tappable.
    var openTarget: ((String) -> Void)?
    /// Where a `#tag` goes when it is tapped (N600). `nil` leaves tags marked
    /// but inert, which is what a context with no stack gets.
    var openTag: ((String) -> Void)?
    /// One table's structure, by the block id of its `table` block.
    ///
    /// A second read rather than a field on `Block`, because rows and columns
    /// are two dimensions and `depth` is one. `nil` while no source is wired,
    /// and a table then draws as the placeholder rather than as nothing.
    var tableContent: ((String) -> TableContent?)?
    /// What a block's `url` points at, by the rule the core owns (Q4).
    ///
    /// `nil` while nothing can resolve one, which draws every attachment as a
    /// placeholder rather than pretending the bytes are missing.
    var attachment: ((String) -> BlockAttachment)?
    /// Detaches an attachment. `nil` hides the action rather than offering
    /// one that cannot work.
    var removeAttachment: ((String) async -> Void)?
    /// Makes a text-bearing block editable (N302).
    ///
    /// `nil` renders the note read-only, which is what a vault with no
    /// identity to sign a write with gets — the keyboard is **absent** rather
    /// than present and refusing.
    var editing: NoteEditingBridge?
    /// Row and column editing for any table in this note (N505).
    var tableEditing: NoteTableEditing?
    /// Set by a table cell so its checkboxes can be numbered and tapped
    /// (N605). `nil` everywhere else.
    var checkboxBase: Int?

    /// `true` inside a table cell, whose own `textColor` is the ink. Anywhere
    /// else the body is drawn in the ordinary ink.
    var inheritsInk = false

    /// Toggles the reader has opened or closed on this screen, by row.
    ///
    /// A view state rather than a write: folding a toggle to read past it is
    /// not an edit, and writing `open` for it would change the note on every
    /// other device.
    @State private var flipped: Set<Int> = []

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            ForEach(NoteBlockList.rows(of: blocks, flipped: flipped), id: \.id) { row in
                NoteBlockView(
                    block: row.block,
                    marker: row.marker,
                    isOpen: row.isOpen,
                    toggle: {
                        if flipped.contains(row.id) {
                            flipped.remove(row.id)
                        } else {
                            flipped.insert(row.id)
                        }
                    },
                    openTarget: openTarget,
                    tableContent: tableContent,
                    attachment: attachment,
                    removeAttachment: removeAttachment,
                    editing: editing,
                    tableEditing: tableEditing,
                    checkboxBase: checkboxBase.map { base in
                        base + NoteBlockList.checkboxesBefore(row.id, in: blocks)
                    }
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(BlockInk(color: inheritsInk ? nil : Tokens.Text.primary.color))
        // Wiki links are `AttributedString` links, so the platform already
        // draws and hits them — including for VoiceOver's link rotor, which a
        // tap gesture over styled text would never have reached. This is the
        // handler that turns one back into a note.
        .environment(\.openURL, OpenURLAction { url in
            if let tag = NoteInline.tagTarget(of: url) {
                guard let openTag else {
                    // Marked but not going anywhere, which is the honest
                    // answer for a context with no stack to push onto.
                    return .handled
                }
                openTag(tag)
                return .handled
            }
            guard let target = NoteInline.wikiTarget(of: url), let openTarget else {
                // No handler, or not one of ours: hand it back to the system
                // rather than swallowing it. A real `https://` link in a note
                // still opens.
                return .systemAction
            }
            openTarget(target)
            return .handled
        })
    }
}

/// The flat block list, prepared for drawing.
///
/// Two things the list cannot say for itself and a single block cannot work
/// out alone: which cells belong to a table that draws itself, and what number
/// a list item is. Both need the sequence, so both are decided here rather
/// than inside `NoteBlockView`.
enum NoteBlockList {
    /// How many inline checkboxes appear in the blocks before this row.
    ///
    /// A cell's checkboxes are numbered across everything it holds, because
    /// that is how the core addresses them: the index counts the checkboxes
    /// in the cell, not the ones in a particular block (N605).
    static func checkboxesBefore(_ rowId: Int, in blocks: [Block]) -> Int {
        rows(of: blocks)
            .prefix { $0.id != rowId }
            .reduce(0) { total, row in
                total + row.block.inline.filter { $0.marks.contains("inlineCheckbox") }.count
            }
    }

    struct Row: Identifiable {
        let id: Int
        let block: Block
        /// The marker a numbered list item draws, already counted.
        let marker: String?
        /// For a toggle, whether it is showing its body.
        var isOpen = false
    }

    /// The rows to draw.
    ///
    /// A closed toggle hides everything nested under it, as desktop does:
    /// its body arrives as the following blocks one depth deeper, and drawing
    /// them anyway made "closed" mean nothing. `flipped` holds the toggles
    /// the reader has opened or closed since, against the document's `open`.
    static func rows(of blocks: [Block], flipped: Set<Int> = []) -> [Row] {
        var rows: [Row] = []
        // Per depth, so a nested list numbers itself and an outer list is not
        // disturbed by it.
        var counters: [UInt32: Int] = [:]
        // While inside a table, everything deeper belongs to it: the table
        // draws its own rows from `Notes.table`, and drawing the cells again
        // as loose paragraphs is what a flat list would otherwise do. Nothing
        // is dropped from the core — this is one surface choosing the richer
        // of two readings of the same content.
        var tableDepth: UInt32?
        // The depth of the closed toggle whose body is being skipped.
        var foldedDepth: UInt32?

        for (offset, block) in blocks.enumerated() {
            if let depth = foldedDepth {
                if block.depth > depth { continue }
                foldedDepth = nil
            }
            if let depth = tableDepth {
                if block.depth > depth { continue }
                tableDepth = nil
            }
            if block.kind == "table" { tableDepth = block.depth }

            var isOpen = false
            if block.kind == "toggleListItem" {
                let stored = block.props.first { $0.name == "open" }?.value == "true"
                isOpen = flipped.contains(offset) ? !stored : stored
                if !isOpen { foldedDepth = block.depth }
            }

            var marker: String?
            if block.kind == "numberedListItem" {
                let next = (counters[block.depth] ?? 0) + 1
                counters[block.depth] = next
                marker = "\(next)."
            } else {
                // Any other block ends the run, so a list after a paragraph
                // starts at one again. Deeper counters go too: a nested list
                // that ended restarts the next time one opens.
                counters = counters.filter { $0.key < block.depth }
            }

            rows.append(Row(id: offset, block: block, marker: marker, isOpen: isOpen))
        }
        return rows
    }
}

/// One block.
struct NoteBlockView: View {
    let block: Block
    /// The list marker this item draws, counted over its siblings by
    /// `NoteBlockList`. `nil` for everything that is not a numbered item.
    var marker: String?
    /// For a toggle, whether its body is showing on this screen.
    var isOpen = false
    /// Opens or closes a toggle on this screen.
    var toggle: (() -> Void)?
    var openTarget: ((String) -> Void)?
    var tableContent: ((String) -> TableContent?)?
    var attachment: ((String) -> BlockAttachment)?
    var removeAttachment: ((String) async -> Void)?
    var editing: NoteEditingBridge?
    var tableEditing: NoteTableEditing?
    /// The ordinal the first inline checkbox in this block takes within its
    /// cell (N605). `nil` outside a table cell, where there is nothing to
    /// address a checkbox with.
    var checkboxBase: Int?

    /// Whether a wiki link's title names a note here, so a broken one can be
    /// drawn as broken. `nil` until the vault's notes are read, which draws
    /// every link as whole rather than guessing.
    @Environment(\.noteTitleExists) private var titleExists
    /// Review marks this block may carry, already narrowed to ones whose
    /// text is unambiguous in the note (see `ReviewMarkStyle`).
    @Environment(\.reviewMarks) private var reviewMarks
    @Environment(\.taskCards) private var taskCards

    var body: some View {
        content
            // A block's own ink, when it declares one. Applied as a tint over
            // the whole block rather than per run: an inline `textColor`
            // wins because it sets its own foreground on the run.
            //
            // **Only when it declares one.** Otherwise the ink is inherited:
            // the note sets the ordinary ink around the whole body, and a
            // table cell sets its own `textColor` around its content, which
            // a default applied here would paint over.
            .modifier(BlockInk(color: blockInk))
            .padding(blockFill == nil ? 0 : Tokens.Space.small)
            .background(blockFill ?? .clear, in: .rect(cornerRadius: Tokens.Radius.control))
            // Indentation carries nesting, exactly as it does in the browse
            // list: the block list is flat and depth is the only thing saying
            // a list item sits inside another.
            .padding(.leading, CGFloat(block.depth) * Tokens.Space.inset)
            .frame(maxWidth: .infinity, alignment: frameAlignment)
    }

    /// `textColor` on the block itself. `nil` for `default`, for an absent
    /// prop, and for a name this build does not know — all three mean "draw
    /// it in the ordinary ink", and none of them mean "guess".
    private var blockInk: Color? {
        value("textColor").flatMap { Tokens.Content.ink(named: $0) }?.color
    }

    private var blockFill: Color? {
        value("backgroundColor").flatMap { Tokens.Content.fill(named: $0) }?.color
    }

    @ViewBuilder
    private var content: some View {
        switch block.kind {
        case "heading":
            // No ink of its own: the block's `textColor`, applied in `body`,
            // is what a coloured heading is drawn in.
            Text(inline)
                .font(headingRole.font)
                .multilineTextAlignment(alignment)
                .accessibilityAddTraits(.isHeader)
        case "bulletListItem", "numberedListItem":
            ListItemRow(marker: marker ?? bullet, text: inline, alignment: alignment)
        case "checkListItem":
            CheckItemRow(isChecked: flag("checked"), text: inline)
        case "taskBlock":
            // A task block is `content: none`: its words are the `title`
            // prop. The task itself adds what desktop's row shows beside
            // them; a task this vault does not hold draws from the props.
            TaskBlockRow(
                title: value("title") ?? "",
                isChecked: flag("checked"),
                card: value("taskId").flatMap { taskCards[$0] }
            )
        case "quote":
            QuoteRow(text: inline)
        case "callout":
            CalloutRow(type: value("type") ?? "info", text: inline)
        case "codeBlock":
            CodeRow(language: value("language"), text: plainText)
        case "divider":
            Divider().overlay(Tokens.Line.border.color)
        case "toggleListItem":
            // The children already arrive as their own blocks one level
            // deeper, so this draws the summary and the state — it does not
            // own the body. A closed toggle hides its children, as desktop
            // does, and a tap opens it (`NoteBlockList.rows`).
            ToggleSummaryRow(isOpen: isOpen, text: inline, alignment: alignment, toggle: toggle)
        case "audio", "video", "file":
            // Openable once the bytes are here, named when they are not.
            // Before these cases existed, audio and video fell through to
            // `default` and drew an empty paragraph, which reads as a hole in
            // the note.
            NoteAttachmentView(
                kind: block.kind,
                url: value("url"),
                name: value("name"),
                size: value("size"),
                caption: value("caption"),
                resolve: attachment,
                remove: removeAttachment
            )
        case "table":
            NoteTableView(
                table: block.id.flatMap { tableContent?($0) },
                openTarget: openTarget,
                editing: tableEditing,
                tableId: block.id
            )
        case "bookmark":
            // The page's own card once its metadata loads, as desktop draws
            // it; the stored props or the address until then. An empty
            // string is "not known", not a name: desktop writes `""` until it
            // has fetched the page.
            BookmarkCard(
                url: value("url"),
                title: value("title"),
                subtitle: [value("siteName"), value("domain")]
                    .compactMap { $0 }
                    .first { !$0.isEmpty }
            )
        case "youtubeEmbed":
            // The video's thumbnail with a play mark, which opens it. No
            // inline player: an embed that only works online would break the
            // offline read this screen is for.
            YouTubeCard(videoUrl: value("videoUrl"), videoId: value("videoId"), title: value("title"))
        case "image", "inlineImage":
            // Real bytes when this device has them, a placeholder when it does
            // not. A block's url is a vault-relative path rather than an
            // attachment id, so the core binds the two (Q4); this screen only
            // renders the four answers it can get back.
            NoteImageView(
                url: value("url"),
                name: value("name"),
                caption: value("caption"),
                previewWidth: value("previewWidth").flatMap(Double.init),
                resolve: attachment,
                remove: removeAttachment
            )
        default:
            // N302's end-to-end path: with an editor wired, an ordinary
            // paragraph is a real `UITextView` (N300's answer) and what the
            // user types reaches `Notes.editBlock`. Without one, the same
            // block draws exactly as it always did.
            //
            // **Only a paragraph of plain text is editable here.** The text
            // view holds a `String`, and its commit is `SetText`, which
            // replaces the block's whole inline content: a paragraph holding a
            // bold word, a colour, a link or a wiki link would draw without
            // them and lose them for good on the first keystroke, on every
            // device. Such a paragraph draws read-only, with everything it
            // holds, until the editor can edit a range rather than the whole.
            //
            // **Nor a paragraph a review mark covers.** The mark is drawn over
            // the text, which a plain text view cannot show, and it is pinned
            // by offsets into desktop's file: editing the text under it moves
            // the words out from under the comment.
            if let editing, let id = block.id, block.kind == "paragraph", isPlainText,
               !reviewMarks.contains(where: { plainText.contains($0.visibleText) }) {
                EditableBlockView(
                    text: editing.text(id, plainText),
                    role: .body,
                    alignment: textViewAlignment,
                    ink: blockInkName.flatMap { Tokens.Content.ink(named: $0) }
                        .map { UIColor($0.color) },
                    commit: { editing.commit(id, $0, plainText) },
                    onReturn: { editing.insertAfter(id) }
                )
            } else if !inlineImages.isEmpty {
                // A table cell's inline image (§12.7.1). It has no text, so
                // as a run it drew as nothing; it is a picture beside the
                // cell's words instead.
                VStack(alignment: .leading, spacing: Tokens.Space.small) {
                    if !inline.characters.isEmpty {
                        Text(inline)
                            .font(Tokens.Typography.body.font)
                            .multilineTextAlignment(alignment)
                    }
                    ForEach(Array(inlineImages.enumerated()), id: \.offset) { _, image in
                        NoteImageView(
                            url: image.markAttrs["inlineImage.src"] ?? image.target,
                            name: image.markAttrs["inlineImage.alt"],
                            caption: nil,
                            previewWidth: nil,
                            resolve: attachment,
                            remove: nil
                        )
                    }
                }
            } else {
                // No ink here: the block's own `textColor` comes from `body`.
                // No font for a table cell's paragraph either: the cell sets
                // the weight that makes a header a header.
                Text(inline)
                    .modifier(BodyFont(skip: block.kind == "tableParagraph"))
                    .multilineTextAlignment(alignment)
            }
        }
    }

    /// All six levels the schema allows.
    ///
    /// This used to answer three, so a level-four heading and a level-six
    /// heading rendered identically and the note lost structure it really
    /// carried. `DESIGN.md`'s ramp was extended rather than the content
    /// clamped; the clamp that remains is the document's own 1...6.
    private var headingRole: TypeRole {
        Tokens.Typography.bodyHeading(level: Int(value("level") ?? "") ?? 1)
    }

    /// BlockNote's bullet ladder: filled, hollow, square, then repeating.
    private var bullet: String {
        ["\u{2022}", "\u{25E6}", "\u{25AA}"][Int(block.depth) % 3]
    }

    private func value(_ name: String) -> String? {
        block.props.first { $0.name == name }?.value
    }

    /// `textAlignment`, as SwiftUI spells it. `props_of` has always returned
    /// it and nothing read it.
    private var alignment: TextAlignment {
        switch value("textAlignment") {
        case "center": .center
        case "right": .trailing
        // `justify` has no `TextAlignment`, and faking it by stretching
        // spaces would be worse than reading as the default.
        default: .leading
        }
    }

    /// The frame alignment that matches [`alignment`], so a centred block sits
    /// centred rather than merely wrapping centred.
    private var frameAlignment: Alignment {
        switch alignment {
        case .center: .center
        case .trailing: .trailing
        default: .leading
        }
    }

    private func flag(_ name: String) -> Bool {
        value(name) == "true"
    }

    private var plainText: String {
        block.inline.map(\.text).joined()
    }

    private var inlineImages: [InlineRun] {
        block.inline.filter { $0.marks.contains("inlineImage") }
    }

    /// True when every run is unmarked text: nothing a `String` would lose.
    private var isPlainText: Bool {
        block.inline.allSatisfy { $0.marks.isEmpty }
    }

    private var blockInkName: String? {
        value("textColor")
    }

    /// `textAlignment` for a text view, which unlike SwiftUI's `Text` can
    /// justify.
    private var textViewAlignment: NSTextAlignment {
        switch value("textAlignment") {
        case "center": .center
        case "right": .right
        case "justify": .justified
        default: .natural
        }
    }

    /// The block's runs as one attributed string, marks applied.
    private var inline: AttributedString {
        var out = AttributedString()
        // Checkboxes are numbered within the cell that owns them, which is
        // what the core addresses (N605). `nil` outside a table cell.
        var ordinal = checkboxBase
        for run in block.inline {
            let isCheckbox = run.marks.contains("inlineCheckbox")
            out.append(
                NoteInline.attributed(
                    run,
                    checkboxOrdinal: isCheckbox ? ordinal : nil,
                    base: block.kind == "heading" ? headingRole.font : nil,
                    titleExists: titleExists
                )
            )
            if isCheckbox, let current = ordinal {
                ordinal = current + 1
            }
        }
        return ReviewMarkStyle.apply(reviewMarks, to: out)
    }
}

/// The body font, or nothing so the surrounding font shows through.
///
/// A modifier rather than `.font(nil)`: a `nil` font is not "inherit", it
/// resets to the system default and throws away the weight a header cell set.
private struct BodyFont: ViewModifier {
    let skip: Bool

    func body(content: Content) -> some View {
        if skip {
            content
        } else {
            content.font(Tokens.Typography.body.font)
        }
    }
}

/// A block's declared ink, or nothing so the surrounding ink shows through.
private struct BlockInk: ViewModifier {
    let color: Color?

    func body(content: Content) -> some View {
        if let color {
            content.foregroundStyle(color)
        } else {
            content
        }
    }
}

private struct ListItemRow: View {
    let marker: String
    let text: AttributedString
    var alignment: TextAlignment = .leading

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Text(marker)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                // A fixed lane, so every marker in a list shares one edge.
                // Numbers past single digits need more than a bullet does.
                .frame(minWidth: Tokens.Space.inset, alignment: .trailing)
                // Hidden from VoiceOver but read in the value below, so the
                // position is spoken once rather than as a stray "3 dot".
                .accessibilityHidden(true)
            Text(text).multilineTextAlignment(alignment)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(String(text.characters))
        .accessibilityValue(marker.hasSuffix(".") ? "Item \(marker.dropLast())" : "")
    }
}

/// A toggle's summary line and the state the note was left in.
private struct ToggleSummaryRow: View {
    let isOpen: Bool
    let text: AttributedString
    var alignment: TextAlignment = .leading
    var toggle: (() -> Void)?

    var body: some View {
        if let toggle {
            row
                .contentShape(.rect)
                .onTapGesture(perform: toggle)
                .accessibilityAddTraits(.isButton)
                .accessibilityHint(isOpen ? "Hides its contents" : "Shows its contents")
        } else {
            row
        }
    }

    private var row: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(minWidth: Tokens.Space.inset, alignment: .trailing)
                .accessibilityHidden(true)
            Text(text).multilineTextAlignment(alignment)
        }
        .accessibilityElement(children: .combine)
        // Said in words: the chevron is the only other cue, and a rotation is
        // never allowed to be the one that carries the state.
        .accessibilityValue(isOpen ? "Expanded" : "Collapsed")
    }
}

private struct CheckItemRow: View {
    let isChecked: Bool
    let text: AttributedString

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Image(systemName: isChecked ? "checkmark.square" : "square")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(isChecked
                    ? Tokens.Text.secondary.color
                    : Tokens.Line.focus.color)
                .accessibilityHidden(true)
            Text(text)
                .strikethrough(isChecked, color: Tokens.Text.secondary.color)
        }
        .accessibilityElement(children: .combine)
        // Said in words: the tick is the only other cue, and colour is never
        // allowed to be the one that carries it.
        .accessibilityValue(isChecked ? "Done" : "Not done")
    }
}

private struct QuoteRow: View {
    let text: AttributedString

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.medium) {
            Rectangle()
                .fill(Tokens.Line.border.color)
                .frame(width: 3)
                .accessibilityHidden(true)
            Text(text)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct CalloutRow: View {
    let type: String
    let text: AttributedString

    private var symbol: String {
        switch type {
        case "warning": "exclamationmark.triangle"
        case "error": "xmark.circle"
        case "success": "checkmark.circle"
        default: "info.circle"
        }
    }

    /// Desktop's callout colours: blue, amber, red and green, carried by the
    /// symbol, a leading bar and a tinted fill. The symbol keeps the type
    /// readable in greyscale and under a colour-blind eye.
    private var hue: String {
        switch type {
        case "warning": "yellow"
        case "error": "red"
        case "success": "green"
        default: "blue"
        }
    }

    private var ink: Color {
        (Tokens.Content.ink(named: hue) ?? Tokens.Text.secondary).color
    }

    private var fill: Color {
        (Tokens.Content.fill(named: hue) ?? Tokens.Canvas.surface).color
    }

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.medium) {
            Image(systemName: symbol)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(ink)
                .accessibilityHidden(true)
            Text(text)
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(fill)
        .overlay(alignment: .leading) {
            Rectangle().fill(ink).frame(width: 3).accessibilityHidden(true)
        }
        .clipShape(.rect(cornerRadius: Tokens.Radius.control))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(type) callout")
    }
}

private struct CodeRow: View {
    let language: String?
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(Tokens.Typography.technicalCaption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            // Horizontal scroll, not wrapping: indentation is part of code,
            // and a wrapped line loses it.
            ScrollView(.horizontal, showsIndicators: false) {
                // Coloured per language, as desktop's shiki colours it.
                Text(CodeHighlighter.attributed(text, language: language))
                    .font(Tokens.Typography.recoveryMaterial.font)
                    .textSelection(.enabled)
            }
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
    }
}
