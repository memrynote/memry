import MemryCore
import SwiftUI

// A wiki link alone on its line, drawn as the row or card its settings ask for
// (issue #2845). Logic lives in `NoteLinkDisplay`; this file only draws.

/// What the card reads a linked note through.
struct NoteLinkSource {
    let reader: any NotesReading
    let filler: (any VaultFilling)?
    let reachability: (any Reachability)?
}

extension EnvironmentValues {
    /// `nil` where nothing can read a note (a table cell): the card then
    /// draws its title and icon only.
    @Entry var noteLinkSource: NoteLinkSource?
}

/// The linked note's extras, read once per card.
struct NoteLinkInfo: Equatable {
    let noteId: String
    let preview: String?
    let cover: NoteCoverValue?

    /// `nil` when no note answers to `target`. Reads only what the link asks for.
    static func load(
        _ card: NoteLinkDisplay.Card, reader: any NotesReading
    ) async throws -> NoteLinkInfo? {
        guard let hit = try await reader.resolveWikiTarget(card.target) else { return nil }
        let display = card.display
        var description: String?
        var cover: NoteCoverValue?
        if display.preview || display.cover, let metadata = try await reader.metadata(id: hit.id) {
            description = display.preview ? NoteLinkPreview.description(in: metadata.properties) : nil
            cover = display.cover ? NoteCoverValue.of(metadata.coverJson) : nil
        }
        var preview = description
        if display.preview, preview == nil, let detail = try await reader.read(id: hit.id) {
            preview = NoteLinkPreview.snippet(ofBody: detail.body.text)
        }
        return NoteLinkInfo(noteId: hit.id, preview: preview, cover: cover)
    }
}

struct NoteLinkCardView: View {
    let card: NoteLinkDisplay.Card
    /// The paragraph drawn as a chip, for a link that stays one.
    let chip: AttributedString
    var open: ((String) -> Void)?

    private enum Phase: Equatable {
        case loading
        case ready(NoteLinkInfo)
        case missing
    }

    @Environment(\.noteLinkSource) private var source
    @State private var phase: Phase

    /// `preloaded` skips the read: a preview or a render test has no vault.
    init(card: NoteLinkDisplay.Card, chip: AttributedString, open: ((String) -> Void)? = nil,
         preloaded: NoteLinkInfo? = nil) {
        self.card = card
        self.chip = chip
        self.open = open
        _phase = State(initialValue: preloaded.map(Phase.ready) ?? .loading)
    }

    var body: some View {
        Group {
            switch phase {
            case .missing:
                // The unresolved-link treatment of `NoteInline`.
                Text(unresolved).multilineTextAlignment(.leading)
            case .loading, .ready:
                if card.isBoxed { boxed } else { chipWithPreview }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: card) { await load() }
    }

    private var info: NoteLinkInfo? {
        if case let .ready(info) = phase { info } else { nil }
    }

    private var unresolved: AttributedString {
        var text = AttributedString(card.title)
        text.foregroundColor = Tokens.Text.secondary.color
        text.underlineStyle = .single.union(.patternDash)
        text.link = NoteInline.wikiURL(for: card.target)
        return text
    }

    /// Size `none`: the chip, then the preview in secondary text.
    private var chipWithPreview: some View {
        let preview = info?.preview.map {
            Text("  " + $0).foregroundStyle(Tokens.Text.secondary.color)
        }
        return (preview.map { Text(chip) + $0 } ?? Text(chip))
            .multilineTextAlignment(.leading)
    }

    @ViewBuilder
    private var boxed: some View {
        let medium = card.display.size == .medium
        let content = NoteLinkBox(title: card.title, preview: info?.preview, cover: info?.cover,
                                  noteId: info?.noteId ?? "", medium: medium)
        if let open {
            Button { open(card.target) } label: { content }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the note")
        } else {
            content
        }
    }

    private func load() async {
        guard let source else { return }
        do {
            if let info = try await NoteLinkInfo.load(card, reader: source.reader) {
                phase = .ready(info)
            } else {
                phase = .missing
            }
        } catch {
            // Stay on the title-only card: the link still opens.
            Log.storage.error("a linked note could not be read", .code(ErrorMapping.userFacing(error).code))
        }
    }
}

/// The bordered row (`small`) or card (`medium`), after the Paper "Note link
/// display" frames. Pixel values are the design's; the type scales.
private struct NoteLinkBox: View {
    let title: String
    let preview: String?
    let cover: NoteCoverValue?
    let noteId: String
    let medium: Bool

    @Environment(\.noteLinkSource) private var source
    @ScaledMetric private var iconSize = 16
    @ScaledMetric private var bigIconSize = 24

    var body: some View {
        HStack(alignment: .center, spacing: medium ? 14 : 10) {
            icon
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(title)
                    .font(Tokens.Typography.body.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.primary.color)
                if let preview {
                    Text(preview)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .lineLimit(medium ? 2 : 1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let cover, let source {
                NoteCoverBand(
                    cover: cover, noteId: noteId, reader: source.reader,
                    filler: source.filler, reachability: source.reachability,
                    height: medium ? 64 : 44
                )
                .frame(width: medium ? 96 : 64, height: medium ? 64 : 44)
                .clipShape(.rect(cornerRadius: Tokens.Radius.small))
                .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, medium ? 14 : 12)
        .padding(.vertical, medium ? 14 : 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: medium ? Tokens.Radius.card : Tokens.Radius.control)
                .strokeBorder(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
        )
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var icon: some View {
        if medium {
            Image(systemName: "doc.text")
                .font(.system(size: bigIconSize))
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(width: 48, height: 48)
                .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: 10))
                .accessibilityHidden(true)
        } else {
            Image(systemName: "doc.text")
                .font(.system(size: iconSize))
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityHidden(true)
        }
    }
}
