import MemryCore
import SwiftUI

// Desktop's Location panel (`filter-panels/location-panel.tsx`): the folders
// and notes that hold tasks, as a tree with task counts, searchable. The core
// builds the list (`locationOptions`, pinned by the task-filtering vectors);
// this page shows it. The location chips and a location rule both use it, so
// it reads its selection through `selection` and writes through `onChange`.

struct TaskFilterLocationView: View {
    let store: TasksStore
    /// The folder paths and note ids picked now.
    let selection: (TasksStore) -> (folders: [String], notes: [String])
    let onChange: (_ folders: [String], _ notes: [String]) -> Void

    @State private var query = ""
    @State private var options: [TaskLocationOption] = []

    private var current: (folders: [String], notes: [String]) { selection(store) }

    var body: some View {
        List {
            if options.isEmpty {
                Text(TasksCopy.filterNoLocations)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            ForEach(options, id: \.id) { option in
                TaskFilterCheckRow(
                    title: option.label.isEmpty ? TasksCopy.Projects.untitled : option.label,
                    isSelected: isSelected(option),
                    count: Int(option.count),
                    identifier: "tasks.filter.location.\(option.kind).\(option.value)"
                ) {
                    Image(systemName: option.kind == "folder" ? "folder" : "doc.text")
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .padding(.leading, CGFloat(option.depth) * Tokens.Space.medium)
                        .accessibilityHidden(true)
                } action: {
                    toggle(option)
                }
                .accessibilityHint(query.isEmpty ? "" : option.context)
            }
        }
        .searchable(text: $query, prompt: TasksCopy.filterSearchLocations)
        .navigationTitle(TasksCopy.filterLocation)
        .task(id: LoadKey(query: query, folders: current.folders, notes: current.notes)) { await load() }
        .accessibilityIdentifier("tasks.filter.locationPage")
    }

    private struct LoadKey: Hashable {
        let query: String
        let folders: [String]
        let notes: [String]
    }

    private func load() async {
        let (folders, notes) = current
        let query = query
        options = await store.read {
            try $0.locationOptions(selectedFolderPaths: folders, selectedNoteIds: notes, query: query)
        } ?? options
    }

    private func isSelected(_ option: TaskLocationOption) -> Bool {
        option.kind == "folder" ? current.folders.contains(option.value) : current.notes.contains(option.value)
    }

    private func toggle(_ option: TaskLocationOption) {
        var (folders, notes) = current
        if option.kind == "folder" {
            folders = TasksStore.toggled(option.value, in: folders)
        } else {
            notes = TasksStore.toggled(option.value, in: notes)
        }
        onChange(folders, notes)
    }
}

extension TaskLocationOption {
    var id: String { "\(kind):\(value)" }
}
