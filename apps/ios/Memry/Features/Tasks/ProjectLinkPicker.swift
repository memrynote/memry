import MemryCore
import SwiftUI

// TP052. The note/file picker the hub links through (and picks the
// overview note with): the core's `searchRelated`, best first, the recent
// list for an empty query. Journals and canvases never appear (the core
// excludes them, as desktop's picker does).

private typealias Copy = TasksCopy.Projects

/// What the picker offers.
enum ProjectLinkPickerMode: String, Identifiable, Sendable {
    /// A note to link (`note` links).
    case note
    /// A file to link (`file` links).
    case file
    /// The project's overview note (`setProjectHomeNote`).
    case homeNote

    var id: String { rawValue }

    var title: String {
        switch self {
        case .note: Copy.addNote
        case .file: Copy.addFile
        case .homeNote: Copy.chooseOverviewNote
        }
    }

    func admits(_ item: RelatedItemRecord) -> Bool {
        self == .file ? item.kind == "file" : item.kind == "note"
    }
}

struct ProjectLinkPicker: View {
    let store: TasksStore
    let mode: ProjectLinkPickerMode
    /// Ids already linked, left out of the list.
    let excluded: Set<String>
    let onPick: (RelatedItemRecord) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [RelatedItemRecord] = []

    var body: some View {
        NavigationStack {
            List(results, id: \.id) { item in
                Button {
                    onPick(item)
                    dismiss()
                } label: {
                    ProjectRelatedLabel(item: item)
                }
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .accessibilityIdentifier("tasks.projectPicker.row.\(item.id)")
            }
            .overlay {
                if results.isEmpty, !query.isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
            .searchable(text: $query, prompt: Copy.searchNotes)
            .navigationTitle(mode.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(Copy.cancel) { dismiss() }
                        .accessibilityIdentifier("tasks.projectPicker.cancel")
                }
            }
            .task(id: query) {
                try? await Task.sleep(for: .milliseconds(query.isEmpty ? 0 : 200))
                guard !Task.isCancelled else { return }
                let found = await store.searchLinkable(query, limit: 50)
                results = found.filter { mode.admits($0) && !excluded.contains($0.id) }
            }
        }
        .accessibilityIdentifier("tasks.projectPicker")
    }
}

/// A note or file: its emoji or a symbol, title and folder.
struct ProjectRelatedLabel: View {
    let item: RelatedItemRecord

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(item.title.isEmpty ? Copy.untitled : item.title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                if let folder = item.folderPath, !folder.isEmpty {
                    Text(folder)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
            }
        } icon: {
            if let emoji = item.emoji, !emoji.isEmpty {
                Text(emoji)
            } else {
                Image(systemName: item.kind == "file" ? "doc" : "doc.text")
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
        }
    }
}
