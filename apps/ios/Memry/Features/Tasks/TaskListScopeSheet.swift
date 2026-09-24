import MemryCore
import SwiftUI

// TP040. The project scope, after desktop's `ProjectPicker` in the tab bar
// (`includeAllOption`, `searchable`) and its starred saved-filter pills:
// All projects, every open project with a search field, then the starred
// saved filters, which apply their filters and sort to the page.

struct TaskListScopeSheet: View {
    let store: TasksStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    row(
                        title: TasksCopy.allProjects,
                        color: nil,
                        selected: store.state.projectId == nil && store.activeSavedFilterId == nil,
                        identifier: "tasks.scope.all"
                    ) {
                        await store.selectProject(nil)
                    }
                    ForEach(matchingProjects, id: \.id) { project in
                        row(
                            title: project.name,
                            color: project.color,
                            selected: store.state.projectId == project.id,
                            identifier: "tasks.scope.project.\(project.id)"
                        ) {
                            await store.selectProject(project.id)
                        }
                    }
                    if openProjects.isEmpty {
                        Text(TasksCopy.noProjects)
                            .font(Tokens.Typography.supporting.font)
                            .foregroundStyle(Tokens.Text.tertiary.color)
                    }
                }
                if !starred.isEmpty {
                    Section(TasksCopy.starredFilters) {
                        ForEach(starred, id: \.id) { filter in
                            row(
                                title: filter.name,
                                color: nil,
                                symbol: "star.fill",
                                selected: store.activeSavedFilterId == filter.id,
                                identifier: "tasks.scope.savedFilter.\(filter.id)"
                            ) {
                                await store.applyStarredFilter(filter)
                            }
                        }
                    }
                }
            }
            .searchable(text: $query, prompt: TasksCopy.searchProjects)
            .navigationTitle(TasksCopy.projectScope)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(TasksCopy.done) { dismiss() }
                        .accessibilityIdentifier("tasks.scope.done")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var openProjects: [ProjectItem] {
        store.projects.filter { $0.archivedAt == nil }
    }

    /// The picker's own search over project names, as desktop's picker does.
    private var matchingProjects: [ProjectItem] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return openProjects }
        return openProjects.filter { $0.name.localizedStandardContains(needle) }
    }

    private var starred: [SavedFilterItem] {
        store.savedFilters.filter(\.starred)
    }

    private func row(
        title: String,
        color: String?,
        symbol: String = "folder",
        selected: Bool,
        identifier: String,
        action: @escaping @MainActor () async -> Void
    ) -> some View {
        Button {
            Task {
                await action()
                dismiss()
            }
        } label: {
            HStack(spacing: Tokens.Space.medium) {
                Image(systemName: symbol)
                    .foregroundStyle(color.map { Tokens.Palette.color($0) } ?? Tokens.Text.secondary.color)
                    .accessibilityHidden(true)
                Text(title)
                    .foregroundStyle(Tokens.Text.primary.color)
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Tokens.Text.primary.color)
                        .accessibilityHidden(true)
                }
            }
            .font(Tokens.Typography.body.font)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier(identifier)
    }
}
