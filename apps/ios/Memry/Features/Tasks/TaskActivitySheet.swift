import MemryCore
import SwiftUI

// TP043. The full activity feed, after desktop's `task-activity-sheet.tsx`:
// a change-type filter, entries grouped by day, "Load more" paging through
// the core (`activity(taskId:actions:limit:offset:)`), and the retention note.

/// The actions the filter offers (`FILTERABLE_ACTIONS`).
enum TaskActivityFilter {
    static let actions = ["created", "updated", "completed", "uncompleted", "moved", "deleted", "superseded"]
}

struct TaskActivitySheet: View {
    let taskId: String
    let taskTitle: String
    let store: TasksStore

    /// `nil` for every change.
    @State private var action: String?
    @State private var entries: [ActivityItem] = []
    @State private var hasMore = false
    @State private var loading = true
    @State private var failed = false
    @State private var fetchingMore = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    filter
                } footer: {
                    Text(TasksCopy.Detail.activityDescription)
                }
                feed
                if hasMore {
                    Button(TasksCopy.Detail.activityMore) {
                        Task { await loadMore() }
                    }
                    .disabled(fetchingMore)
                    .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
                    .accessibilityIdentifier("tasks.detail.activityMore")
                }
                Section {
                    EmptyView()
                } footer: {
                    Text(TasksCopy.Detail.activityRetention(TaskActivityPaging.retentionDays))
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(TasksCopy.Detail.activityTitle(taskTitle))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(TasksCopy.Detail.close) { dismiss() }
                        .accessibilityIdentifier("tasks.detail.activityClose")
                }
            }
            .task(id: action) { await reload() }
        }
        .accessibilityIdentifier("tasks.detail.activitySheet")
    }

    private var filter: some View {
        Picker(TasksCopy.Detail.activityFilter, selection: $action) {
            Text(TasksCopy.Detail.activityFilterAll).tag(String?.none)
            ForEach(TaskActivityFilter.actions, id: \.self) { value in
                Text(TasksCopy.Detail.activityAction(value)).tag(String?.some(value))
            }
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityIdentifier("tasks.detail.activityFilter")
    }

    @ViewBuilder
    private var feed: some View {
        if loading {
            Text(TasksCopy.Detail.activityLoading)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.tertiary.color)
        } else if failed {
            Text(TasksCopy.Detail.activityError)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Interaction.destructive.color)
        } else if entries.isEmpty {
            Text(TasksCopy.Detail.activityEmpty)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.tertiary.color)
        } else {
            let now = store.clock()
            ForEach(Array(TaskActivityFormat.days(entries, now: now).enumerated()), id: \.offset) { _, day in
                Section(day.label) {
                    ForEach(day.entries, id: \.id) { entry in
                        TaskActivityRow(line: TaskActivityFormat.line(entry, now: now))
                    }
                }
            }
        }
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        let page = await store.detailActivity(
            taskId: taskId,
            action: action,
            limit: TaskActivityPaging.page,
            offset: 0
        )
        failed = page == nil
        entries = page?.entries ?? []
        hasMore = page?.hasMore ?? false
    }

    private func loadMore() async {
        guard !fetchingMore else { return }
        fetchingMore = true
        defer { fetchingMore = false }
        guard let page = await store.detailActivity(
            taskId: taskId,
            action: action,
            limit: TaskActivityPaging.page,
            offset: UInt32(entries.count)
        ) else { return }
        let known = Set(entries.map(\.id))
        entries += page.entries.filter { !known.contains($0.id) }
        hasMore = page.hasMore
    }
}
