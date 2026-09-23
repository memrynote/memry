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
        case "diagram":
            // A Mermaid diagram's source. Desktop renders the picture with
            // mermaid, which this build does not carry; the source is the
            // whole of the block, so it is shown rather than a blank.
            CodeRow(language: "mermaid", text: plainText)
        case "mathBlock":
            // `content: none`: the formula is the `latex` prop. Shown as its
            // source for the same reason, since KaTeX is not in this build.
            CodeRow(language: "LaTeX", text: value("latex") ?? "")
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
