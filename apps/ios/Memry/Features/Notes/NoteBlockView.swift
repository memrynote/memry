import MemryCore
import SwiftUI

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

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            ForEach(NoteBlockList.rows(of: blocks), id: \.id) { row in
                NoteBlockView(
                    block: row.block,
                    marker: row.marker,
                    openTarget: openTarget,
                    tableContent: tableContent,
                    attachment: attachment,
                    removeAttachment: removeAttachment
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Wiki links are `AttributedString` links, so the platform already
        // draws and hits them — including for VoiceOver's link rotor, which a
        // tap gesture over styled text would never have reached. This is the
        // handler that turns one back into a note.
        .environment(\.openURL, OpenURLAction { url in
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
    struct Row: Identifiable {
        let id: Int
        let block: Block
        /// The marker a numbered list item draws, already counted.
        let marker: String?
    }

    static func rows(of blocks: [Block]) -> [Row] {
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

        for (offset, block) in blocks.enumerated() {
            if let depth = tableDepth {
                if block.depth > depth { continue }
                tableDepth = nil
            }
            if block.kind == "table" { tableDepth = block.depth }

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

            rows.append(Row(id: offset, block: block, marker: marker))
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
    var openTarget: ((String) -> Void)?
    var tableContent: ((String) -> TableContent?)?
    var attachment: ((String) -> BlockAttachment)?
    var removeAttachment: ((String) async -> Void)?

    var body: some View {
        content
            // A block's own ink, when it declares one. Applied as a tint over
            // the whole block rather than per run: an inline `textColor`
            // wins because it sets its own foreground on the run.
            .foregroundStyle(blockInk ?? Tokens.Text.primary.color)
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
            Text(inline)
                .font(headingRole.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityAddTraits(.isHeader)
        case "bulletListItem", "numberedListItem":
            ListItemRow(marker: marker ?? bullet, text: inline, alignment: alignment)
        case "checkListItem", "taskBlock":
            CheckItemRow(isChecked: flag("checked"), text: inline)
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
            // own the body. A closed toggle still shows its children rather
            // than hiding them: this screen reads a note, and a reader who
            // cannot open a disclosure would simply lose the text. The
            // chevron says which way the note was left.
            ToggleSummaryRow(isOpen: flag("open"), text: inline, alignment: alignment)
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
                openTarget: openTarget
            )
        case "bookmark":
            // A bookmark carries its whole card in props — url, title, site —
            // and needs nothing fetched, so it is a real link rather than a
            // placeholder. The preview image is the one part that would need
            // bytes, and it is left out rather than faked.
            LinkCardRow(
                url: value("url"),
                title: value("title"),
                subtitle: value("siteName") ?? value("domain"),
                symbol: "bookmark"
            )
        case "youtubeEmbed":
            // Same: the video is somewhere else either way, so a link that
            // opens it beats a grey box that does not. No inline player — the
            // note body is not a video surface, and an embed that only works
            // online would break the offline read this screen is for.
            LinkCardRow(
                url: value("videoUrl"),
                title: value("title"),
                subtitle: "Watch on YouTube",
                symbol: "play.rectangle"
            )
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
            Text(inline)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
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

    /// The block's runs as one attributed string, marks applied.
    private var inline: AttributedString {
        var out = AttributedString()
        for run in block.inline {
            out.append(NoteInline.attributed(run))
        }
        return out
    }
}

/// Runs to attributed text. A free function so the mapping is asserted over
/// values rather than through a rendered view.
enum NoteInline {
    /// The scheme a wiki link is carried under.
    ///
    /// A link rather than a tap gesture because a link is what the platform
    /// understands: it draws it, hits it, and lists it in VoiceOver's link
    /// rotor. The scheme is private to this app and never leaves it — the
    /// handler above resolves it and hands the system nothing.
    static let wikiScheme = "memry-wiki"

    /// The title a wiki-link URL carries, or `nil` for any other URL.
    static func wikiTarget(of url: URL) -> String? {
        guard url.scheme == wikiScheme else { return nil }
        // The whole tail, percent-decoded: a note title is free text and can
        // hold slashes, spaces and `#`, none of which survive being read as
        // host-and-path.
        let raw = url.absoluteString.dropFirst("\(wikiScheme)://".count)
        return raw.removingPercentEncoding.map { $0 } ?? String(raw)
    }

    /// A wiki link's URL, or `nil` when there is no target to point at.
    static func wikiURL(for target: String) -> URL? {
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let encoded = trimmed.addingPercentEncoding(
                  withAllowedCharacters: .alphanumerics
              )
        else { return nil }
        return URL(string: "\(wikiScheme)://\(encoded)")
    }

    static func attributed(_ run: InlineRun) -> AttributedString {
        var piece = AttributedString(run.text)
        var font = Tokens.Typography.body.font
        for mark in run.marks {
            switch mark {
            case "bold": font = font.bold()
            case "italic": font = font.italic()
            case "code": font = Tokens.Typography.recoveryMaterial.font
            case "strike": piece.strikethroughStyle = .single
            case "underline": piece.underlineStyle = .single
            case "textColor":
                // The name is not the value. Until `mark_attrs` existed the
                // core sent a bare `textColor` and red and blue arrived
                // identical; now the value crosses and an unknown name
                // leaves the text in the ordinary ink rather than guessing.
                if let name = run.markAttrs[mark], let ink = Tokens.Content.ink(named: name) {
                    piece.foregroundColor = ink.color
                }
            case "backgroundColor":
                if let name = run.markAttrs[mark], let fill = Tokens.Content.fill(named: name) {
                    piece.backgroundColor = fill.color
                }
            case "inlineCheckbox":
                // A table cell cannot hold a block, so a checkbox inside one
                // is an inline node carrying no text (chapter 12 §12.7.1).
                // It arrives as an empty run and would draw as nothing.
                piece.append(AttributedString(
                    run.markAttrs["inlineCheckbox.checked"] == "true" ? "\u{2611}" : "\u{2610}"
                ))
            case "wikiLink", "linkMention":
                piece.foregroundColor = Tokens.Text.tint.color
                piece.underlineStyle = .single
                // A link only where there is somewhere to go. The run's target
                // is the note's **title** (chapter 12 §12.3), and resolving it
                // happens on the tap: a note can hold many links, and looking
                // every one of them up to draw the screen would be a query per
                // link for an answer most are never asked for.
                if let target = run.target, let url = wikiURL(for: target) {
                    piece.link = url
                }
            case "link", "href":
                piece.foregroundColor = Tokens.Text.tint.color
                piece.underlineStyle = .single
                // A real web address, left to the system.
                if let target = run.target, let url = URL(string: target) {
                    piece.link = url
                }
            case "hashTag", "dateMention":
                // Marked, not linked: this build has no tag screen and no
                // calendar to open, and a word that looks tappable and does
                // nothing is worse than a word that does not.
                piece.foregroundColor = Tokens.Text.tint.color
            default:
                // An unknown mark leaves the text alone rather than dropping
                // it. Losing a word to a mark nobody taught this build is the
                // failure; losing the emphasis is not.
                break
            }
        }
        piece.font = font
        if piece.foregroundColor == nil {
            piece.foregroundColor = Tokens.Text.primary.color
        }
        return piece
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

    var body: some View {
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

    /// The type is carried by the symbol as well as the tint, so a callout
    /// still reads in greyscale and under a colour-blind eye.
    private var tint: Color {
        switch type {
        case "warning", "error": Tokens.Interaction.destructive.color
        case "success": Tokens.Text.primary.color
        default: Tokens.Tint.base.color
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.medium) {
            Image(systemName: symbol)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(text)
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
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
                Text(text)
                    .font(Tokens.Typography.recoveryMaterial.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .textSelection(.enabled)
            }
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
    }
}

/// A bookmark or a video: a card that opens the address it holds.
private struct LinkCardRow: View {
    let url: String?
    let title: String?
    let subtitle: String?
    let symbol: String

    /// `nil` for a block whose url is missing or unparseable — an older
    /// build's block, or one whose prop never arrived. It then draws as a
    /// card that plainly does not open, rather than as a button that fails.
    private var destination: URL? {
        guard let url, !url.isEmpty else { return nil }
        return URL(string: url)
    }

    private var label: String {
        if let title, !title.isEmpty { return title }
        // The address itself, which is the only other true name for it.
        return url ?? "A link is here"
    }

    var body: some View {
        if let destination {
            Link(destination: destination) { card }
                .accessibilityAddTraits(.isLink)
        } else {
            card
        }
    }

    private var card: some View {
        HStack(spacing: Tokens.Space.medium) {
            Image(systemName: symbol)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(label)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .lineLimit(2)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: Tokens.Radius.card)
                .stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
        )
        .accessibilityElement(children: .combine)
    }
}
