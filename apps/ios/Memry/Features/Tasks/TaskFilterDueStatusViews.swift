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
