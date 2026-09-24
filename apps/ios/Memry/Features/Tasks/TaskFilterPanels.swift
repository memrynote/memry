import MemryCore
import SwiftUI

// TP048. The multi-select panels pushed from the filter sheet, after desktop's
// `filters/filter-panels/{project,priority,tag}-panel.tsx`.

/// Tags, any number, searchable.
struct TaskFilterTagsView: View {
    let store: TasksStore
    @State private var query = ""

    private var selected: [String] { store.state.filters.tags }

    var body: some View {
        List {
            if rows.isEmpty {
                Text(TasksCopy.filterNoTags)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            ForEach(rows, id: \.tag) { row in
                TaskFilterCheckRow(
                    title: "#\(row.tag)",
                    isSelected: selected.contains { $0.lowercased() == row.tag.lowercased() },
                    count: row.count,
                    identifier: "tasks.filter.tag.\(row.tag)"
                ) {
                    Circle()
                        .fill(Tokens.Palette.color(nil, tag: row.tag))
                        .frame(width: Tokens.Space.small, height: Tokens.Space.small)
                        .accessibilityHidden(true)
                } action: {
                    let next = TasksStore.toggledTag(row.tag, in: selected)
                    Task { await store.updateFilters { $0.tags = next } }
                }
            }
        }
        .searchable(text: $query, prompt: TasksCopy.filterSearchTags)
        .navigationTitle(TasksCopy.filterTags)
        .toolbar { TaskFilterClearButton(isEnabled: !selected.isEmpty, store: store) { $0.tags = [] } }
    }

    /// The task tags plus any selected tag no live task carries any more, so
    /// it can still be cleared.
    private var rows: [(tag: String, count: Int)] {
        var all = store.filterTags
        for tag in selected where !all.contains(where: { $0.tag.lowercased() == tag.lowercased() }) {
            all.append((tag, 0))
        }
        guard !query.isEmpty else { return all }
        return all.filter { $0.tag.localizedCaseInsensitiveContains(query) }
    }
}

/// The toolbar "Clear" a panel shows for its own dimension.
struct TaskFilterClearButton: ToolbarContent {
    let isEnabled: Bool
    let store: TasksStore
    let clear: @Sendable (inout TaskFilterSpec) -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button(TasksCopy.filterClear) {
                Task { await store.updateFilters(clear) }
            }
            .disabled(!isEnabled)
            .accessibilityIdentifier("tasks.filter.panelClear")
        }
    }
}
