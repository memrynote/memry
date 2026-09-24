import MemryCore
import SwiftUI

// TP043. The detail's activity preview, after desktop's
// `task-activity-section.tsx`: the last three entries inline, and "Show all N"
// into the full feed (`TaskActivitySheet`) when there are more. Re-read after
// every change to the task, since each write may log an entry.

struct TaskActivitySection: View {
    let task: TaskItem
    let store: TasksStore

    @State private var page: ActivityPageItem?
    @State private var failed = false
    @State private var showingAll = false

    var body: some View {
        Section {
            if failed {
                Text(TasksCopy.Detail.activityError)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Interaction.destructive.color)
            } else if let page {
                if page.entries.isEmpty {
                    Text(TasksCopy.Detail.activityEmpty)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                }
                ForEach(page.entries, id: \.id) { entry in
                    TaskActivityRow(line: TaskActivityFormat.line(entry, now: store.clock()))
                }
            } else {
                Text(TasksCopy.Detail.activityLoading)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
        } header: {
            HStack {
                Text(TasksCopy.Detail.activity)
                Spacer()
                if let page, Int(page.total) > page.entries.count {
                    Button(TasksCopy.Detail.activityShowAll(Int(page.total))) {
                        showingAll = true
                    }
                    .font(Tokens.Typography.label.font)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .accessibilityIdentifier("tasks.detail.activityShowAll")
                }
            }
        }
        .task(id: task) { await load() }
        .sheet(isPresented: $showingAll) {
            TaskActivitySheet(taskId: task.id, taskTitle: task.title, store: store)
        }
    }

    private func load() async {
        let loaded = await store.detailActivity(
            taskId: task.id,
            action: nil,
            limit: TaskActivityPaging.preview,
            offset: 0
        )
        failed = loaded == nil
        if let loaded { page = loaded }
    }
}

/// One entry on the timeline (`TaskActivityRow`): a rail with a dot, the
/// label and its old → new values (or the description's size change), then
/// who and when. VoiceOver reads the whole row as one sentence; the arrow is
/// decorative and mirrors in right-to-left layouts.
struct TaskActivityRow: View {
    let line: TaskActivityLine

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.medium) {
            Circle()
                .fill(line.isSuperseded ? Tokens.Task.dueToday.color : Tokens.Text.tertiary.color)
                .frame(width: Tokens.Space.small, height: Tokens.Space.small)
                .padding(.top, Tokens.Space.small)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                change
                Text("\(line.actor) · \(line.time)")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, Tokens.Space.tight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line.accessibilityText)
    }

    private var change: some View {
        FlowLayout(spacing: Tokens.Space.tight) {
            Text(line.label)
                .foregroundStyle(Tokens.Text.secondary.color)
            if let summary = line.summary {
                Text(summary)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            } else {
                if let old = line.oldText {
                    Text(old)
                        .strikethrough(line.isSuperseded)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .lineLimit(1)
                }
                if line.oldText != nil, line.newText != nil {
                    Image(systemName: "arrow.forward")
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .flipsForRightToLeftLayoutDirection(true)
                }
                if let new = line.newText {
                    Text(new)
                        .foregroundStyle(Tokens.Text.primary.color)
                        .lineLimit(1)
                }
            }
        }
        .font(Tokens.Typography.supporting.font)
    }
}
