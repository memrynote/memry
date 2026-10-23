import MemryCore
import SwiftUI

// #3477, D18, #3474. The Readwise section markers, drawn as the labeled
// divider desktop shows. The core carries each marker as an `htmlComment`
// inline node alone in its paragraph; its bytes stay the node's `source`.
// The block draws read-only, so nothing here can write the marker, and an
// edit made on iOS outside the section leaves it untouched for the pulling
// desktop's next run. iOS uses the hairline style: line, book, label, line.

enum ReadwiseMarker: String, CaseIterable {
    case noteStart = "readwise:start"
    case noteEnd = "readwise:end"
    case dayStart = "readwise-day:start"
    case dayEnd = "readwise-day:end"

    /// Desktop's `notes.editor.content.readwise` labels.
    var label: String {
        switch self {
        case .noteStart: "Readwise · syncs automatically"
        case .noteEnd: "End of Readwise section"
        case .dayStart: "Readwise · today's highlights"
        case .dayEnd: "End of Readwise"
        }
    }

    /// The marker a comment's source spells, as desktop reads it
    /// (`READWISE_MARKER`): `<!-- readwise:start -->`, extra words allowed
    /// after the name.
    static func parse(source: String) -> ReadwiseMarker? {
        var text = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix("<!--"), text.hasSuffix("-->") else { return nil }
        text = String(text.dropFirst(4).dropLast(3)).trimmingCharacters(in: .whitespacesAndNewlines)
        let name = text.prefix { !$0.isWhitespace }
        return ReadwiseMarker(rawValue: String(name))
    }

    /// The marker a paragraph is made of, when it holds nothing else.
    static func of(_ block: Block) -> ReadwiseMarker? {
        guard block.kind == "paragraph" else { return nil }
        let comments = block.inline.filter { $0.marks.contains("htmlComment") }
        let others = block.inline.filter { !$0.marks.contains("htmlComment") && !$0.text.allSatisfy(\.isWhitespace) }
        guard comments.count == 1, others.isEmpty, let source = comments[0].markAttrs["htmlComment.source"]
        else { return nil }
        return parse(source: source)
    }
}

struct ReadwiseDivider: View {
    let marker: ReadwiseMarker

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            line
            Image(systemName: "book")
                .font(Tokens.Typography.caption.font)
                .accessibilityHidden(true)
            Text(marker.label)
                .font(Tokens.Typography.caption.font)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .layoutPriority(1)
            line
        }
        .foregroundStyle(Tokens.Text.tertiary.color)
        .padding(.vertical, Tokens.Space.small)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(marker.label)
        .accessibilityIdentifier("note.readwiseDivider.\(marker.rawValue)")
    }

    private var line: some View {
        Rectangle()
            .fill(Tokens.Line.border.color)
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.hairline, maxHeight: Tokens.Size.hairline)
    }
}
