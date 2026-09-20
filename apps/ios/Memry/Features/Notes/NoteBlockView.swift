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
        case "image", "inlineImage", "file":
            // **Blocked on the core, not on this screen.** Attachment bytes
            // travel their own path (chapter 13 §13.8) and nothing on the FFI
            // carries them, so this phone has the block and not the file.
            // Naming the file beats an empty gap in the middle of a note.
            AttachmentRow(kind: block.kind, name: value("name"), size: value("size"))
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

/// A picture or a file: the block is here, the bytes are not.
private struct AttachmentRow: View {
    let kind: String
    let name: String?
    let size: String?

    private var symbol: String {
        kind == "file" ? "doc" : "photo"
    }

    private var label: String {
        if let name, !name.isEmpty { return name }
        return kind == "file" ? "A file is here" : "A picture is here"
    }

    /// Bytes, said in the units a person uses. Absent rather than guessed when
    /// the prop carries nothing — "0 KB" would be a claim about the file.
    private var measured: String? {
        guard let size, let bytes = Int64(size), bytes > 0 else { return nil }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    var body: some View {
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
                // What is true: the file lives beside the vault on the
                // computer and has never been sent to this phone. No retry,
                // because there is nothing here that could fetch it.
                Text(measured.map { "\($0) · on your computer" } ?? "On your computer")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
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

