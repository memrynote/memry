import MemryCore
import SwiftUI

// TP048, redesigned (RD13). The filter sheet (Paper artboard 13): close (xmark)
// / Filter / done (checkmark), a search field, the quick presets as capsules,
// then one native menu row per dimension (Project, Priority, Tags, Due,
// Status, Repeat, Time, Show), and a footer with Clear all and Save as view.
// Multi-value rows keep their menu open while you tick (`menuActionDismiss
// Behavior(.disabled)`); the due row reaches its custom range and the tags
// row its search on a pushed page. Saved views (apply, star, rename, delete,
// reorder) sit on their own page below the rows.
//
// Every change writes the store's filters at once, so the list behind the
// sheet is always the answer. Group and sort live in the list's … menu (RD12).

struct TaskFilterSheet: View {
    let store: TasksStore

    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var search = ""
    @State private var isSaving = false
    @State private var pushed: Page?

    private enum Page: Hashable { case due, tags, saved }

    private var filters: TaskFilterSpec { store.state.filters }

    var body: some View {
        NavigationStack {
            Form {
                Section { searchField }
                Section { presets }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                Section { TaskFilterDimensionRows(store: store, openDue: { pushed = .due }, openTags: { pushed = .tags }) }
                Section { footer }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                if !store.savedFilters.isEmpty {
                    Section {
                        Button {
                            pushed = .saved
                        } label: {
                            LabeledContent(TasksCopy.filterSavedTitle, value: "\(store.savedFilters.count)")
                                .foregroundStyle(Tokens.Text.primary.color)
                        }
                        .accessibilityIdentifier("tasks.filter.savedViews")
                    }
                }
            }
            .font(Tokens.Typography.body.font)
            .navigationTitle(TasksCopy.filterTitle)
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(item: $pushed) { page in
                switch page {
                case .due: TaskFilterDueView(store: store)
                case .tags: TaskFilterTagsView(store: store)
                case .saved: SavedFiltersPage(store: store)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .accessibilityIdentifier("tasks.filter.close")
                }
                ToolbarItem(placement: .confirmationAction) {
                    SheetConfirmButton(label: TasksCopy.filterDone) { dismiss() }
                        .accessibilityIdentifier("tasks.filter.done")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear { search = filters.search }
        .task(id: search) { await commitSearch() }
        .savedFilterNamePrompt(
            isPresented: $isSaving,
            title: TasksCopy.saveFilter,
            confirm: TasksCopy.saveFilter,
            initialName: ""
        ) { name in
            await store.saveCurrentFilter(name: name)
        }
        .accessibilityIdentifier("tasks.filter.sheet")
    }

    // MARK: Pieces

    private var searchField: some View {
        HStack(spacing: Tokens.Space.small) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Tokens.Text.tertiary.color)
                .accessibilityHidden(true)
            TextField(TasksCopy.filterSearchPlaceholder, text: $search)
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
                .accessibilityIdentifier("tasks.filter.search")
            if !search.isEmpty {
                Button { search = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(TasksCopy.filterClearSearch)
            }
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
    }

    /// Capsules that wrap; at accessibility sizes they stack full width.
    private var presets: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Tokens.Space.small))
            : AnyLayout(TaskFlowLayout(horizontal: Tokens.Space.small, vertical: 0))
        return layout {
            ForEach(TaskFilterPreset.allCases) { preset in
                TaskFilterPresetButton(preset: preset, isActive: TaskFilterPreset.active(in: filters) == preset) {
                    Task { await store.applyQuickPreset(preset) }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(TasksCopy.filterQuickFilters)
    }

    private var footer: some View {
        HStack {
            Button(TasksCopy.filterClearAll) {
                search = ""
                Task { await store.clearFilters() }
            }
            .foregroundStyle(Tokens.Text.tertiary.color)
            .disabled(!filters.isActive)
            .accessibilityLabel(TasksCopy.filterClearAllLabel)
            .accessibilityIdentifier("tasks.filter.clearAll")
            Spacer(minLength: Tokens.Space.medium)
            Button(TasksCopy.filterSaveAsView) { isSaving = true }
                .fontWeight(.semibold)
                .foregroundStyle(filters.isActive ? Tokens.Text.tint.color : Tokens.Text.tertiary.color)
                .disabled(!filters.isActive)
                .accessibilityIdentifier("tasks.filter.save")
        }
        .font(Tokens.Typography.body.font)
        .buttonStyle(.plain)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .padding(.horizontal, Tokens.Space.tight)
    }

    /// Writes the search field a beat after typing stops, so each keystroke
    /// does not re-run the page query.
    private func commitSearch() async {
        guard search != filters.search else { return }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        let text = search
        await store.updateFilters { $0.search = text }
    }
}

/// The dimension rows: each a native menu, the value trailing.
private struct TaskFilterDimensionRows: View {
    let store: TasksStore
    let openDue: () -> Void
    let openTags: () -> Void

    private var filters: TaskFilterSpec { store.state.filters }

    var body: some View {
        multi(TasksCopy.filterProject, value: projectSummary, identifier: "tasks.filter.projects") {
            ForEach(store.projects.filter { $0.archivedAt == nil }, id: \.id) { project in
                toggle(project.name, isOn: filters.projectIds.contains(project.id)) {
                    let next = TasksStore.toggled(project.id, in: filters.projectIds)
                    Task { await store.updateFilters { $0.projectIds = next } }
                }
            }
        }
        multi(TasksCopy.filterPriority, value: prioritySummary, identifier: "tasks.filter.priorities") {
            ForEach(TaskFilterOptions.priorities, id: \.self) { name in
                toggle(TaskFilterOptions.priorityLabel(name), isOn: filters.priorities.contains(name)) {
                    let next = TasksStore.toggled(name, in: filters.priorities)
                    Task { await store.updateFilters { $0.priorities = next } }
                }
            }
        }
        multi(TasksCopy.filterTags, value: filters.tags.isEmpty ? nil : filters.tags.joined(separator: ", "),
              identifier: "tasks.filter.tags") {
            ForEach(store.filterTags.prefix(20), id: \.tag) { entry in
                toggle("#\(entry.tag)", isOn: filters.tags.contains { $0.caseInsensitiveCompare(entry.tag) == .orderedSame }) {
                    let next = TasksStore.toggledTag(entry.tag, in: filters.tags)
                    Task { await store.updateFilters { $0.tags = next } }
                }
            }
            Button(TasksCopy.filterSearchTags, systemImage: "magnifyingglass", action: openTags)
        }
        Menu {
            Picker(TasksCopy.filterDueDate, selection: choice(filters.dueDate.type) { type in
                Task { await store.setDueFilter(type) }
            }) {
                ForEach(TaskFilterOptions.dueTypes, id: \.self) { type in
                    Text(TasksCopy.dueFilterLabel(type)).tag(type)
                }
            }
            .pickerStyle(.inline)
            Button(TasksCopy.filterCustomRange, systemImage: "calendar", action: openDue)
        } label: {
            TaskFilterMenuRow(
                title: TasksCopy.filterDue,
                value: filters.dueDate.type == "any" ? nil : TaskFilterOptions.dueLabel(filters.dueDate),
                isAlert: filters.dueDate.type == "overdue"
            )
        }
        .accessibilityIdentifier("tasks.filter.dueDate")
        multi(TasksCopy.filterStatus, value: statusSummary, identifier: "tasks.filter.status") {
            // Statuses belong to one project each, so each project is its own submenu.
            ForEach(store.projects.filter { $0.archivedAt == nil && !$0.statuses.isEmpty }, id: \.id) { project in
                Menu(project.name) {
                    ForEach(project.statuses, id: \.id) { status in
                        toggle(status.name, isOn: filters.statusIds.contains(status.id)) {
                            let next = TasksStore.toggled(status.id, in: filters.statusIds)
                            Task { await store.updateFilters { $0.statusIds = next } }
                        }
                    }
                }
            }
        }
        single(TasksCopy.filterRepeat, TaskFilterOptions.repeatTypes, filters.repeatType, TasksCopy.repeatFilterLabel,
               "tasks.filter.repeat") { value in await store.updateFilters { $0.repeatType = value } }
        single(TasksCopy.filterHasTime, TaskFilterOptions.hasTimes, filters.hasTime, TasksCopy.hasTimeFilterLabel,
               "tasks.filter.hasTime") { value in await store.updateFilters { $0.hasTime = value } }
        single(TasksCopy.filterCompletion, TaskFilterOptions.completions, filters.completion,
               TasksCopy.completionFilterLabel, "tasks.filter.completion") { value in
            await store.updateFilters { $0.completion = value }
        }
    }

    // MARK: Row builders

    private func multi(
        _ title: String, value: String?, identifier: String, @ViewBuilder items: () -> some View
    ) -> some View {
        Menu {
            items()
        } label: {
            TaskFilterMenuRow(title: title, value: value)
        }
        .menuActionDismissBehavior(.disabled)
        .accessibilityIdentifier(identifier)
    }

    // swiftlint:disable:next function_parameter_count
    private func single(
        _ title: String, _ options: [String], _ selection: String, _ label: @escaping (String) -> String,
        _ identifier: String, _ write: @escaping @MainActor (String) async -> Void
    ) -> some View {
        // A value from a newer build stays selectable rather than blanking the menu.
        let choices = options.contains(selection) ? options : options + [selection]
        return Menu {
            Picker(title, selection: choice(selection) { value in Task { await write(value) } }) {
                ForEach(choices, id: \.self) { Text(label($0)).tag($0) }
            }
            .pickerStyle(.inline)
        } label: {
            TaskFilterMenuRow(title: title, value: selection == options.first ? nil : label(selection))
        }
        .accessibilityIdentifier(identifier)
    }

    private func toggle(_ title: String, isOn: Bool, action: @escaping () -> Void) -> some View {
        Toggle(title, isOn: Binding(get: { isOn }, set: { _ in action() }))
    }

    private func choice(_ value: String, set: @escaping (String) -> Void) -> Binding<String> {
        Binding(get: { value }, set: { next in if next != value { set(next) } })
    }

    // MARK: Summaries

    private var projectSummary: String? {
        let names = filters.projectIds.compactMap { id in store.projects.first { $0.id == id }?.name }
        return names.isEmpty ? nil : names.joined(separator: ", ")
    }

    private var prioritySummary: String? {
        let labels = filters.priorities.map(TaskFilterOptions.priorityLabel)
        return labels.isEmpty ? nil : labels.joined(separator: ", ")
    }

    private var statusSummary: String? {
        filters.statusIds.isEmpty ? nil : TasksCopy.filterSelectedCount(filters.statusIds.count)
    }
}

/// A dimension row: the name, its value ("Any" when unset) and the menu's
/// up-down chevron.
private struct TaskFilterMenuRow: View {
    let title: String
    let value: String?
    var isAlert = false

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Text(title).foregroundStyle(Tokens.Text.primary.color)
            Spacer(minLength: Tokens.Space.small)
            Text(value ?? TasksCopy.filterAny)
                .foregroundStyle(isAlert ? Tokens.Task.dueOverdue.color : Tokens.Text.tertiary.color)
                .lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .font(Tokens.Typography.caption.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.tertiary.color)
                .accessibilityHidden(true)
        }
        .font(Tokens.Typography.body.font)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

extension TasksCopy {
    static let filterDue = "Due"
    static let filterSaveAsView = "Save as view"
}
