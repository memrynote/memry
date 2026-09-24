import MemryCore
import SwiftUI

// TP048. The due date and status panels, after desktop's
// `filter-panels/due-date-panel.tsx` and `status-panel.tsx` /
// `status-project-picker-panel.tsx`. Which tasks a preset admits is the
// core's question (`filter_by_due_date_range`); this only writes the choice.

/// Due date: one preset, or a custom range of two days.
struct TaskFilterDueView: View {
    let store: TasksStore
    @State private var start = Date()
    @State private var end = Date()

    private var due: DueDateFilterSpec { store.state.filters.dueDate }

    var body: some View {
        Form {
            Section {
                ForEach(TaskFilterOptions.dueTypes, id: \.self) { type in
                    TaskFilterCheckRow(
                        title: TasksCopy.dueFilterLabel(type),
                        isSelected: due.type == type,
                        identifier: "tasks.filter.due.\(type)"
                    ) {
                        EmptyView()
                    } action: {
                        Task { await store.setDueFilter(type) }
                    }
                }
            }
            Section {
                DatePicker(TasksCopy.filterRangeStart, selection: $start, displayedComponents: .date)
                    .accessibilityIdentifier("tasks.filter.due.customStart")
                DatePicker(TasksCopy.filterRangeEnd, selection: $end, in: start..., displayedComponents: .date)
                    .accessibilityIdentifier("tasks.filter.due.customEnd")
                Button(TasksCopy.filterApplyRange) {
                    let first = start
                    let last = end
                    Task { await store.setDueFilterRange(from: first, to: last) }
                }
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .accessibilityIdentifier("tasks.filter.due.customApply")
            } header: {
                HStack {
                    Text(TasksCopy.filterCustomRange)
                    if due.type == "custom" {
                        Image(systemName: "checkmark").accessibilityHidden(true)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(due.type == "custom" ? [.isHeader, .isSelected] : .isHeader)
            }
        }
        .font(Tokens.Typography.body.font)
        .navigationTitle(TasksCopy.filterDueDate)
        .toolbar {
            TaskFilterClearButton(isEnabled: due.type != "any", store: store) { $0.dueDate = DueDateFilterSpec() }
        }
        .onAppear(perform: seedRange)
    }

    /// The pickers open on the applied range, or on today.
    private func seedRange() {
        let today = store.clock()
        start = due.customStart.flatMap(TaskFilterOptions.parseDate) ?? today
        end = max(start, due.customEnd.flatMap(TaskFilterOptions.parseDate) ?? start)
    }
}

/// Status: pick one project, then any of its statuses. Statuses are
/// per-project, so a list mixing projects would offer three "To Do" rows.
struct TaskFilterStatusView: View {
    let store: TasksStore
    @State private var projectId: String?

    private var selected: [String] { store.state.filters.statusIds }

    private var visibleProjects: [ProjectItem] {
        store.projects.filter { $0.archivedAt == nil }
    }

    var body: some View {
        Form {
            Section(TasksCopy.filterPickAProject) {
                Picker(TasksCopy.filterProject, selection: $projectId) {
                    Text(TasksCopy.filterPickAProject).tag(String?.none)
                    ForEach(visibleProjects, id: \.id) { project in
                        Text(project.name).tag(Optional(project.id))
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("tasks.filter.statusProject")
            }
            if let project = store.project(projectId) {
                Section(TasksCopy.filterStatus) {
                    if project.statuses.isEmpty {
                        Text(TasksCopy.filterNoStatuses)
                            .foregroundStyle(Tokens.Text.secondary.color)
                    }
                    ForEach(project.statuses, id: \.id) { status in
                        TaskFilterCheckRow(
                            title: status.name,
                            isSelected: selected.contains(status.id),
                            identifier: "tasks.filter.statusOption.\(status.id)"
                        ) {
                            TaskStatusIcon(
                                statusType: status.statusType,
                                isDone: status.isDone,
                                color: Tokens.Palette.color(status.color)
                            )
                            .accessibilityHidden(true)
                        } action: {
                            let next = TasksStore.toggled(status.id, in: selected)
                            Task { await store.updateFilters { $0.statusIds = next } }
                        }
                    }
                }
            }
        }
        .font(Tokens.Typography.body.font)
        .navigationTitle(TasksCopy.filterStatus)
        .toolbar { TaskFilterClearButton(isEnabled: !selected.isEmpty, store: store) { $0.statusIds = [] } }
        .onAppear(perform: seedProject)
    }

    /// Starts on the page's project, the one filtered project, or the project
    /// of an already chosen status.
    private func seedProject() {
        guard projectId == nil else { return }
        let filters = store.state.filters
        if let scope = store.state.projectId {
            projectId = scope
        } else if filters.projectIds.count == 1 {
            projectId = filters.projectIds.first
        } else if let statusId = filters.statusIds.first {
            projectId = store.projects.first { $0.statuses.contains { $0.id == statusId } }?.id
        }
    }
}
