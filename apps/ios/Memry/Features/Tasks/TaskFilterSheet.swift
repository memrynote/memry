import MemryCore
import SwiftUI

// TP048. The filter sheet: every `TaskFilterSpec` dimension, the quick
// presets, group-by field and direction, and the saved filters. Desktop splits
// this over a filter dropdown with panels (`filters/filter-dropdown.tsx`), a
// quick filter bar and a group-by picker; on the phone they share one sheet,
// with a pushed screen per multi-value panel. Each change writes the store's
// filters at once, so the list behind the sheet is always the answer.

/// The filter sheet.
struct TaskFilterSheet: View {
    let store: TasksStore
    @Environment(\.dynamicTypeSize) private var typeSize

    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    private var filters: TaskFilterSpec { store.state.filters }

    var body: some View {
        NavigationStack {
            Form {
                searchSection
                presetSection
                dimensionSection
                scopeSection
                groupSection
                SavedFilterSection(store: store)
            }
            .navigationTitle(TasksCopy.filterTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
        }
        .onAppear { search = filters.search }
        .task(id: search) { await commitSearch() }
        .accessibilityIdentifier("tasks.filter.sheet")
    }

    // MARK: Sections

    private var searchSection: some View {
        Section {
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
            .font(Tokens.Typography.body.font)
        }
    }

    private var presetSection: some View {
        Section(TasksCopy.filterQuickFilters) {
            // Pills flow at regular sizes; at accessibility sizes one wide
            // pill would not fit a row, so they stack full width.
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: Tokens.Space.small))
                : AnyLayout(FlowLayout(spacing: Tokens.Space.small))
            layout {
                ForEach(TaskFilterPreset.allCases) { preset in
                    TaskFilterPresetButton(
                        preset: preset,
                        isActive: TaskFilterPreset.active(in: filters) == preset
                    ) {
                        Task { await store.applyQuickPreset(preset) }
                    }
                }
            }
            .padding(.vertical, Tokens.Space.tight)
        }
    }

    private var dimensionSection: some View {
        Section(TasksCopy.filterBy) {
            NavigationLink {
                TaskFilterProjectsView(store: store)
            } label: {
                TaskFilterRowLabel(title: TasksCopy.filterProject, symbol: "folder", value: projectSummary)
            }
            .accessibilityIdentifier("tasks.filter.projects")
            NavigationLink {
                TaskFilterPrioritiesView(store: store)
            } label: {
                TaskFilterRowLabel(title: TasksCopy.filterPriority, symbol: "flag", value: prioritySummary)
            }
            .accessibilityIdentifier("tasks.filter.priorities")
            NavigationLink {
                TaskFilterTagsView(store: store)
            } label: {
                TaskFilterRowLabel(title: TasksCopy.filterTags, symbol: "tag", value: tagSummary)
            }
            .accessibilityIdentifier("tasks.filter.tags")
            NavigationLink {
                TaskFilterDueView(store: store)
            } label: {
                TaskFilterRowLabel(
                    title: TasksCopy.filterDueDate,
                    symbol: "calendar",
                    value: filters.dueDate.type == "any" ? nil : TaskFilterOptions.dueLabel(filters.dueDate)
                )
            }
            .accessibilityIdentifier("tasks.filter.dueDate")
            NavigationLink {
                TaskFilterStatusView(store: store)
            } label: {
                TaskFilterRowLabel(title: TasksCopy.filterStatus, symbol: "circle.dashed", value: statusSummary)
            }
            .accessibilityIdentifier("tasks.filter.status")
        }
    }

    private var scopeSection: some View {
        Section {
            TaskFilterChoicePicker(
                title: TasksCopy.filterCompletion,
                options: TaskFilterOptions.completions,
                selection: filters.completion,
                label: TasksCopy.completionFilterLabel,
                identifier: "tasks.filter.completion"
            ) { value in
                Task { await store.updateFilters { $0.completion = value } }
            }
            TaskFilterChoicePicker(
                title: TasksCopy.filterRepeat,
                options: TaskFilterOptions.repeatTypes,
                selection: filters.repeatType,
                label: TasksCopy.repeatFilterLabel,
                identifier: "tasks.filter.repeat"
            ) { value in
                Task { await store.updateFilters { $0.repeatType = value } }
            }
            TaskFilterChoicePicker(
                title: TasksCopy.filterHasTime,
                options: TaskFilterOptions.hasTimes,
                selection: filters.hasTime,
                label: TasksCopy.hasTimeFilterLabel,
                identifier: "tasks.filter.hasTime"
            ) { value in
                Task { await store.updateFilters { $0.hasTime = value } }
            }
        }
    }

    private var groupSection: some View {
        Section(TasksCopy.filterGroupBy) {
            TaskFilterChoicePicker(
                title: TasksCopy.filterGroupBy,
                options: TaskFilterOptions.groupFields,
                selection: store.state.sort.field,
                label: TasksCopy.filterSortFieldLabel,
                identifier: "tasks.filter.sortField"
            ) { field in
                Task { await store.setSortField(field) }
            }
            Picker(TasksCopy.filterSortDirection, selection: directionBinding) {
                Label(TasksCopy.filterSortAscending, systemImage: "arrow.up").tag("asc")
                Label(TasksCopy.filterSortDescending, systemImage: "arrow.down").tag("desc")
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("tasks.filter.sortDirection")
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(TasksCopy.filterClearAll, role: .destructive) {
                search = ""
                Task { await store.clearFilters() }
            }
            .disabled(!filters.isActive)
            .accessibilityLabel(TasksCopy.filterClearAllLabel)
            .accessibilityIdentifier("tasks.filter.clearAll")
        }
        ToolbarItem(placement: .confirmationAction) {
            Button(TasksCopy.filterDone) { dismiss() }
                .accessibilityIdentifier("tasks.filter.done")
        }
    }

    // MARK: Helpers

    private var directionBinding: Binding<String> {
        Binding(
            get: { store.state.sort.direction == "desc" ? "desc" : "asc" },
            set: { direction in Task { await store.setSortDirection(direction) } }
        )
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

    private var projectSummary: String? {
        let names = filters.projectIds.compactMap { id in store.projects.first { $0.id == id }?.name }
        return names.isEmpty ? nil : names.joined(separator: ", ")
    }

    private var prioritySummary: String? {
        let labels = filters.priorities.map(TaskFilterOptions.priorityLabel)
        return labels.isEmpty ? nil : labels.joined(separator: ", ")
    }

    private var tagSummary: String? {
        filters.tags.isEmpty ? nil : filters.tags.joined(separator: ", ")
    }

    private var statusSummary: String? {
        filters.statusIds.isEmpty ? nil : TasksCopy.filterSelectedCount(filters.statusIds.count)
    }
}
