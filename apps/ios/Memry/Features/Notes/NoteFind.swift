import MemryCore
import Observation
import SwiftUI
import UIKit

// MARK: - N801, find in note

/// One match: which block it is in, and where.
struct NoteMatch: Equatable, Identifiable, Sendable {
    let id: Int
    /// The index of the block in the flat list, so a caller can scroll to it.
    let blockIndex: Int
    let blockId: String?
    /// The whole line the match sits in, for the result row.
    let line: String
}

/// Searching inside one note's blocks.
///
/// **Client-side over blocks already read, not a query.** The note is on
/// screen, so its text is already here; going back to the core would be a
/// second read of something this view is holding, and it would search the
/// flattened note rather than the blocks the user can be scrolled to.
enum NoteFind {
    /// Every block whose text contains `query`, case-insensitively.
    ///
    /// Case-insensitive because a reader looking for "kitchen" means the
    /// sentence that starts one. Empty for an empty query rather than every
    /// block, which is what "no search" should look like.
    static func matches(of query: String, in blocks: [Block]) -> [NoteMatch] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return [] }

        return blocks.enumerated().compactMap { index, block in
            let line = block.inline.map(\.text).joined()
            guard line.localizedCaseInsensitiveContains(needle) else { return nil }
            return NoteMatch(
                id: index,
                blockIndex: index,
                blockId: block.id,
                line: line
            )
        }
    }
}

/// The find bar and its results.
struct NoteFindView: View {
    let blocks: [Block]
    /// Scrolls the note to a block. `nil` lists matches without moving.
    var scrollTo: ((String) -> Void)?

    @State private var query = ""

    private var matches: [NoteMatch] { NoteFind.matches(of: query, in: blocks) }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            TextField("Find in note", text: $query)
                .textFieldStyle(.roundedBorder)
                .font(Tokens.Typography.body.font)
                .accessibilityLabel("Find in this note")

            if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                if matches.isEmpty {
                    // The truth, rather than an empty list that reads as a
                    // still-loading one.
                    Text("Nothing in this note matches.")
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                } else {
                    Text("\(matches.count) \(matches.count == 1 ? "match" : "matches")")
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)

                    ForEach(matches) { match in
                        Button {
                            if let id = match.blockId { scrollTo?(id) }
                        } label: {
                            Text(match.line)
                                .font(Tokens.Typography.supporting.font)
                                .foregroundStyle(Tokens.Text.primary.color)
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .disabled(match.blockId == nil || scrollTo == nil)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The find bar pinned over a page, with its close button: the note page's
/// and the journal day's "Find".
struct NoteFindPanel: View {
    let blocks: [Block]
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            HStack {
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark")
                        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                }
                .accessibilityLabel("Close find")
            }
            NoteFindView(blocks: blocks)
        }
        .padding(.horizontal, Tokens.Space.screenInline)
        .padding(.bottom, Tokens.Space.small)
        .background(Tokens.Canvas.background.color)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Tokens.Line.border.color)
                .frame(height: Tokens.Size.hairline)
        }
    }
}
