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
    /// Where this block sits among its siblings, for the block menu's Move
    /// up and Move down. `nil` offers no block menu (a table cell's blocks).
    var siblings: BlockSiblings?

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
            // After the frame, so the handle sits in the page margin whatever
            // the block's depth or alignment.
            .modifier(BlockActionsAttachment(
                runner: actionRunner,
                editsInPlace: editing.flatMap(editableField) != nil
            ) {
                NoteBlockView(
                    block: block, marker: marker, isOpen: isOpen,
                    tableContent: tableContent, attachment: attachment
                )
            })
    }

    /// Blocks drawn read-only that already answer a long press: a table's
    /// cells, a task's menu, a checklist item's task menu, and code whose
    /// text is selectable. The block menu would shadow or fight them.
    private static let ownLongPressKinds: Set<String> = [
        "table", "taskBlock", "checkListItem", "codeBlock", "diagram",
    ]

    private var actionRunner: BlockActionRunner? {
        guard let editing, let siblings, block.id != nil else { return nil }
        if editableField(editing) == nil, Self.ownLongPressKinds.contains(block.kind) { return nil }
        return BlockActionRunner(
            session: editing.session, target: BlockActionTarget(block: block, siblings: siblings)
        )
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
        if let editing, let field = editableField(editing) {
            editableRow(field)
        } else {
            readContent
        }
    }

    /// The kinds whose text is edited in place: every text block the insert
    /// menu makes, except the callout, whose row draws its own chrome.
    private static let editableKinds: Set<String> = [
        "paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem",
        "toggleListItem", "quote", "codeBlock",
    ]

    /// The text view for this block, or `nil` when it draws read-only.
    ///
    /// Marks and inline nodes no longer make a block read-only: its text is
    /// written with `ReplaceText`, which keeps them. Still read-only: a block
    /// a review mark covers (the mark is pinned by offsets into desktop's
    /// file, and editing under it moves the words out from under the
    /// comment), and a cell's inline images and checkboxes.
    private func editableField(_ editing: NoteEditingBridge) -> EditableBlockView? {
        guard block.id != nil, Self.editableKinds.contains(block.kind), !isAnsweredView,
              !block.inline.contains(where: { $0.marks.contains("inlineImage") || $0.marks.contains("inlineCheckbox") }),
              !reviewMarks.contains(where: { plainText.contains($0.visibleText) })
        else { return nil }
        let role: TypeRole = switch block.kind {
        case "heading": headingRole
        case "codeBlock": Tokens.Typography.recoveryMaterial
        default: Tokens.Typography.body
        }
        var ink = blockInkName.flatMap { Tokens.Content.ink(named: $0) }.map { UIColor($0.color) }
        if block.kind == "quote", ink == nil { ink = UIColor(Tokens.Text.secondary.color) }
        return EditableBlockView(
            block: block, session: editing.session, role: role, alignment: textViewAlignment, ink: ink
        )
    }

    @ViewBuilder
    private func editableRow(_ field: EditableBlockView) -> some View {
        switch block.kind {
        case "heading":
            field.accessibilityAddTraits(.isHeader)
        case "bulletListItem", "numberedListItem":
            EditableMarkerRow(marker: marker ?? bullet) { field }
        case "checkListItem":
            EditableCheckRow(isChecked: flag("checked"), toggle: block.id.map { id in
                { Task { await editing?.session.model?.setProp(id, "checked", flag("checked") ? "false" : "true"); await editing?.session.didChange() } }
            }) { field }
                .modifier(ChecklistTaskMenu(blockId: block.id))
        case "toggleListItem":
            EditableToggleRow(isOpen: isOpen, toggle: toggle) { field }
        case "quote":
            EditableQuoteRow { field }
        case "codeBlock":
            VStack(alignment: .leading, spacing: Tokens.Space.small) {
                if let language = value("language"), !language.isEmpty {
                    Text(language)
                        .font(Tokens.Typography.technicalCaption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                field
            }
            .padding(Tokens.Space.inset)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
        default:
            field
        }
    }

    @ViewBuilder
    private var readContent: some View {
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
            // TP054: convert into a task, and nest under a task line.
            CheckItemRow(isChecked: flag("checked"), text: inline)
                .modifier(ChecklistTaskMenu(blockId: block.id))
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
        case "codeBlock" where value("language") == ViewBlockFence.language:
            ViewBlockView(text: plainText)
        case "codeBlock":
            CodeRow(language: value("language"), text: plainText)
        case "diagram":
            // A Mermaid diagram's source. Desktop renders the picture with
            // mermaid, which this build does not carry; the source is the
            // whole of the block, so it is shown rather than a blank.
            CodeRow(language: "mermaid", text: plainText)
        case "mathBlock":
            // `content: none`: the formula is the `latex` prop.
            let latex = value("latex") ?? ""
            MathBlockView(latex: latex, edit: editing.flatMap { editing in
                block.id.map { id in { editing.session.editSource(BlockSourceRequest(blockId: id, source: latex)) } }
            })
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
                mimeType: value("mimeType"),
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
            // An editable paragraph never reaches here (`editableField`).
            if !inlineImages.isEmpty {
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

    /// A view block this build draws as rows. It stays out of the text editor
    /// so its fence is never rewritten here; one it cannot answer is edited as
    /// the code it shows.
    private var isAnsweredView: Bool {
        block.kind == "codeBlock" && value("language") == ViewBlockFence.language
            && ViewBlockFence(text: plainText) != .code
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
