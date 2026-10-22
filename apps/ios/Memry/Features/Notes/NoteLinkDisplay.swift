import Foundation
import MemryCore

/// How one wiki link asks to be drawn: the `size`, `cover` and `preview`
/// attributes of the CRDT `wikiLink` node (issue #2845), which the core
/// hands over in `InlineRun.markAttrs` as `wikiLink.size` and friends.
///
/// **Read only.** This build draws the settings and never writes them.
/// **Tolerant.** An absent attribute, an unknown size from a newer build and a
/// boolean spelled `"true"` or `"1"` all resolve to a draw rather than a drop.
struct NoteLinkDisplay: Equatable, Hashable, Sendable {
    enum Size: String, Sendable {
        /// Today's chip.
        case none
        case small
        case medium
    }

    var size: Size = .none
    var cover = false
    var preview = false

    init(size: Size = .none, cover: Bool = false, preview: Bool = false) {
        self.size = size
        self.cover = cover
        self.preview = preview
    }

    init(_ run: InlineRun) {
        size = run.markAttrs["wikiLink.size"].flatMap(Size.init(rawValue:)) ?? .none
        cover = Self.flag(run.markAttrs["wikiLink.cover"])
        preview = Self.flag(run.markAttrs["wikiLink.preview"])
    }

    private static func flag(_ value: String?) -> Bool {
        guard let value = value?.lowercased() else { return false }
        return value == "true" || value == "1"
    }

    /// A paragraph whose only content is one wiki link.
    struct Card: Equatable, Hashable, Sendable {
        let target: String
        let title: String
        let display: NoteLinkDisplay

        /// `size` is not `none`: the row or card, not a chip.
        var isBoxed: Bool { display.size != .none }
    }

    /// The link a paragraph consists of, when it has a setting to draw.
    ///
    /// A link inside running text always stays a chip and ignores `size`, so
    /// the answer is `nil` the moment the paragraph holds any other text. A
    /// whitespace-only run is not text. A chip with neither a size nor a
    /// preview has nothing to add and also answers `nil`.
    static func card(in block: Block) -> Card? {
        guard block.kind == "paragraph" else { return nil }
        let runs = block.inline.filter {
            !($0.marks.isEmpty && $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        guard runs.count == 1, let run = runs.first, run.marks.contains("wikiLink"),
              let target = run.markAttrs["wikiLink.target"] ?? run.target,
              !target.isEmpty
        else { return nil }
        let display = NoteLinkDisplay(run)
        guard display.size != .none || display.preview else { return nil }
        return Card(target: target, title: NoteInlineLabel.text(of: run), display: display)
    }
}

/// The words under a link's title.
enum NoteLinkPreview {
    /// The note's `description` property when it is a non-empty string.
    static func description(in properties: [NoteProperty]) -> String? {
        guard let property = properties.first(where: { $0.name == "description" }),
              let value = try? JSONSerialization.jsonObject(
                  with: Data(property.valueJson.utf8), options: .fragmentsAllowed
              ) as? String
        else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The first lines of a body, from `extract_text` output: its `#` and
    /// `- ` markers are a preview convention, not words.
    static func snippet(ofBody text: String, lines: Int = 3, limit: Int = 240) -> String? {
        let words = text.split(whereSeparator: \.isNewline)
            .map { line -> String in
                var line = line.trimmingCharacters(in: .whitespaces)
                while line.hasPrefix("#") { line.removeFirst() }
                for marker in ["- ", "* "] where line.hasPrefix(marker) { line.removeFirst(2) }
                return line.trimmingCharacters(in: .whitespaces)
            }
            .filter { !$0.isEmpty }
            .prefix(lines)
            .joined(separator: " ")
        return words.isEmpty ? nil : String(words.prefix(limit))
    }
}
