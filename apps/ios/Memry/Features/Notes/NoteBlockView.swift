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

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                NoteBlockView(block: block, openTarget: openTarget)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One block.
struct NoteBlockView: View {
    let block: Block
    var openTarget: ((String) -> Void)?

    var body: some View {
        content
            // Indentation carries nesting, exactly as it does in the browse
            // list: the block list is flat and depth is the only thing saying
            // a list item sits inside another.
            .padding(.leading, CGFloat(block.depth) * Tokens.Space.inset)
            .frame(maxWidth: .infinity, alignment: .leading)
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
            ListItemRow(marker: block.kind == "bulletListItem" ? "•" : "1.", text: inline)
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
        case "image", "inlineImage", "file", "bookmark", "youtubeEmbed":
            // The block is real and this build cannot draw it. Saying which
            // one, and where it works, beats an empty gap in the middle of a
            // note (`DESIGN.md`: a clear limitation, never a silent hole).
            UnsupportedBlockRow(kind: block.kind, caption: value("name") ?? value("url"))
        default:
            Text(inline)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
        }
    }

    /// Heading levels map onto the type ramp rather than onto sizes: `DESIGN.md`
    /// closes the ramp deliberately, so a level past it clamps instead of
    /// inventing a step.
    private var headingRole: TypeRole {
        switch value("level") {
        case "1": Tokens.Typography.screenTitle
        case "2": Tokens.Typography.sectionTitle
        default: Tokens.Typography.heading
        }
    }

    private func value(_ name: String) -> String? {
        block.props.first { $0.name == name }?.value
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
            case "wikiLink", "link", "href", "linkMention":
                piece.foregroundColor = Tokens.Tint.base.color
                piece.underlineStyle = .single
            case "hashTag", "dateMention":
                piece.foregroundColor = Tokens.Tint.base.color
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

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Text(marker)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                // A fixed lane, so every marker in a list shares one edge.
                .frame(width: Tokens.Space.inset, alignment: .trailing)
                .accessibilityHidden(true)
            Text(text)
        }
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

/// A block this build cannot draw yet.
private struct UnsupportedBlockRow: View {
    let kind: String
    let caption: String?

    private var name: String {
        switch kind {
        case "image", "inlineImage": "picture"
        case "file": "file"
        case "bookmark": "bookmark"
        case "youtubeEmbed": "video"
        default: kind
        }
    }

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            Image(systemName: "square.dashed")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text("A \(name) is here")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                Text(caption ?? "This phone cannot show it yet. It is on your computer.")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
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

