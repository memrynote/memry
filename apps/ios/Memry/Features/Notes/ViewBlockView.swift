import MemryCore
import SwiftUI

/// A `memry-view` code block: the rows its definition selects, or its code
/// when this build cannot answer the definition or has no vault to read.
struct ViewBlockView: View {
    let text: String
    /// Opens the query sheet. `nil` on a read-only page.
    var edit: (() -> Void)?

    @Environment(\.openNote) private var openNote
    @Environment(\.vaultBrowse) private var browse
    @Environment(\.settingsContext) private var settings
    @Environment(\.noteTasks) private var taskActions
    @State private var read: Read = .loading

    private enum Read: Equatable {
        case loading
        case ready(notes: [NoteSummary], noteTags: [String: [String]])
        case folderMissing
        case failed
    }

    var body: some View {
        if case let .rows(query) = ViewBlockFence(text: text), let reader = browse?.reader {
            VStack(alignment: .leading, spacing: Tokens.Space.small) {
                HStack(spacing: Tokens.Space.small) {
                    Text(Self.sourceLabel(query.source))
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 0)
                    if let edit {
                        Button(action: edit) {
                            Image(systemName: "slider.horizontal.3")
                                .foregroundStyle(Tokens.Text.secondary.color)
                                .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Edit view")
                    }
                }
                rowsFrame(query)
            }
            .task(id: query) { read = await Self.load(query, reader: reader) }
        } else {
            CodeRow(language: ViewBlockFence.language, text: text)
        }
    }

    /// Lazy so a long view draws only the rows on screen when its note opens.
    private func rowsFrame(_ query: ViewBlockQuery) -> some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            switch read {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(Tokens.Space.inset)
            case .folderMissing:
                notice(ViewBlockCopy.folderMissing)
            case .failed:
                notice(ViewBlockCopy.loadFailed)
            case let .ready(notes, noteTags):
                let rows = query.rows(notes: notes, noteTags: noteTags, tasks: settings?.tasks.ordered ?? [])
                if rows.isEmpty {
                    notice(ViewBlockCopy.empty)
                } else {
                    ForEach(rows) { row in
                        if row.id != rows.first?.id { Divider().overlay(Tokens.Line.border.color) }
                        rowButton(row)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.card).stroke(Tokens.Line.border.color))
        .clipShape(.rect(cornerRadius: Tokens.Radius.card))
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.secondary.color)
            .padding(Tokens.Space.inset)
    }

    private func rowButton(_ row: ViewBlockRow) -> some View {
        Button {
            if let route = row.noteRoute {
                openNote?(route)
            } else {
                taskActions?.open?(row.id)
            }
        } label: {
            HStack(spacing: Tokens.Space.small) {
                icon(row)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .accessibilityHidden(true)
                Text(row.title.isEmpty ? ViewBlockCopy.untitled : row.title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .strikethrough(row.kind == .task(done: true))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Tokens.Space.medium)
            .padding(.vertical, Tokens.Space.small)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(Self.accessibilityValue(row.kind))
    }

    @ViewBuilder
    private func icon(_ row: ViewBlockRow) -> some View {
        switch row.kind {
        case .note:
            if let emoji = row.emoji, !emoji.isEmpty {
                Text(emoji)
            } else {
                Image(systemName: "doc.text")
            }
        case let .task(done):
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
        }
    }

    private static func accessibilityValue(_ kind: ViewBlockRow.Kind) -> String {
        switch kind {
        case .note: ""
        case let .task(done): done ? TasksCopy.taskDone : TasksCopy.taskNotDone
        }
    }

    private static func sourceLabel(_ source: ViewBlockQuery.Source) -> String {
        switch source {
        case .vault: ViewBlockCopy.allNotes
        case let .folder(path): path.isEmpty ? ViewBlockCopy.allNotes : path
        case let .tag(tag, andTags): ([tag] + andTags).map { "#\($0)" }.joined(separator: " ")
        }
    }

    /// The notes a query reads. A tag source reads every tag in the source's
    /// and the ANDed tags' families, so ``ViewBlockQuery/rows`` can tell which
    /// note carries which.
    private static func load(_ query: ViewBlockQuery, reader: any NotesReading) async -> Read {
        do {
            switch query.source {
            case .vault:
                return .ready(notes: try await reader.list(), noteTags: [:])
            case let .folder(path):
                let notes = try await reader.list()
                guard ViewBlockQuery.folderExists(path, configured: try await reader.folders(), notes: notes) else {
                    return .folderMissing
                }
                return .ready(notes: notes, noteTags: [:])
            case .tag:
                break
            }
            let needles = query.tagNeedles
            let names = try await reader.tags().map(\.name).filter { name in
                needles.contains { ViewBlockQuery.tags([name], match: $0) }
            }
            var notes: [NoteSummary] = []
            var noteTags: [String: [String]] = [:]
            for name in names {
                for note in try await reader.notesTagged(name) {
                    if noteTags[note.id] == nil { notes.append(note) }
                    noteTags[note.id, default: []].append(name)
                }
            }
            return .ready(notes: notes, noteTags: noteTags)
        } catch {
            Log.interface.error("a view block's notes did not read")
            return .failed
        }
    }
}

extension EnvironmentValues {
    /// Pushes a note by id onto the note screen's stack; `nil` where there is
    /// no stack to push onto.
    @Entry var openNote: ((NoteRoute) -> Void)?
}

/// Desktop's `notes.json` `editor.viewBlock.*`, except `untitled`, which is
/// its `editor.title.untitled`.
enum ViewBlockCopy {
    static let allNotes = "All notes"
    static let empty = "Nothing matches this view yet."
    static let folderMissing = "This folder is not in the vault any more. Pick another source."
    static let loadFailed = "Could not load this view. The notes themselves are untouched."
    static let untitled = "Untitled"
}
