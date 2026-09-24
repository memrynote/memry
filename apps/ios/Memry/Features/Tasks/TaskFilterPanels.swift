import MemryCore
import SwiftUI

// TP048. The multi-select panels pushed from the filter sheet, after desktop's
// `filters/filter-panels/{project,priority,tag}-panel.tsx`.

/// Projects, any number (`project-panel.tsx`: archived projects hidden).
struct TaskFilterProjectsView: View {
    let store: TasksStore

    private var selected: [String] { store.state.filters.projectIds }

    var body: some View {
        List {
            Section {
                ForEach(store.projects.filter { $0.archivedAt == nil }, id: \.id) { project in
                    TaskFilterCheckRow(
                        title: project.name,
                        isSelected: selected.contains(project.id),
                        identifier: "tasks.filter.project.\(project.id)"
                    ) {
                        Circle()
                            .fill(Tokens.Palette.color(project.color))
                            .frame(width: Tokens.Space.small, height: Tokens.Space.small)
                            .accessibilityHidden(true)
                    } action: {
                        let next = TasksStore.toggled(project.id, in: selected)
                        Task { await store.updateFilters { $0.projectIds = next } }
                    }
                }
            }
        }
        .navigationTitle(TasksCopy.filterProject)
        .toolbar { TaskFilterClearButton(isEnabled: !selected.isEmpty, store: store) { $0.projectIds = [] } }
    }
}

/// Priorities, any number, with how many tasks carry each.
struct TaskFilterPrioritiesView: View {
    let store: TasksStore

    private var selected: [String] { store.state.filters.priorities }

    var body: some View {
        List {
            ForEach(TaskFilterOptions.priorities, id: \.self) { name in
                let value = TaskFilterOptions.priorityValue(name)
                TaskFilterCheckRow(
                    title: TaskFilterOptions.priorityLabel(name),
                    isSelected: selected.contains(name),
                    count: counts[value, default: 0],
                    identifier: "tasks.filter.priority.\(name)"
                ) {
                    TaskPriorityIcon(priority: value)
                        .frame(minWidth: Tokens.Space.section)
                        .accessibilityHidden(true)
                } action: {
                    let next = TasksStore.toggled(name, in: selected)
                    Task { await store.updateFilters { $0.priorities = next } }
                }
            }
        }
        .navigationTitle(TasksCopy.filterPriority)
        .toolbar { TaskFilterClearButton(isEnabled: !selected.isEmpty, store: store) { $0.priorities = [] } }
    }

    private var counts: [Int64: Int] {
        Dictionary(grouping: store.ordered.filter { $0.archivedAt == nil }, by: \.priority).mapValues(\.count)
    }
}

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
