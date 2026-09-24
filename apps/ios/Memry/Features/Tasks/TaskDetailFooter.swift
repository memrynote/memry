import MemryCore
import SwiftUI

// TP043, redesigned (RD08). The detail's footer (Paper "Activity footer"):
// one line, "Created Sep 12 · Edited 2h ago" (and when it was archived), that
// opens the full activity feed (`TaskActivitySheet`). Unarchive and Delete
// moved to the "…" menu (artboard 10).

struct TaskDetailFooter: View {
    let task: TaskItem
    let store: TasksStore

    @State private var showsActivity = false

    var body: some View {
        Button {
            showsActivity = true
        } label: {
            HStack(spacing: Tokens.Space.tight) {
                Text(TaskDetailMeta.line(task, now: store.clock()))
                    .multilineTextAlignment(.leading)
                Image(systemName: "chevron.forward")
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                    .accessibilityHidden(true)
            }
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.tertiary.color)
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowSeparator(.hidden)
        .listRowInsets(TaskDetailLayout.bodyInsets(top: Tokens.Space.small))
        .accessibilityHint(TasksCopy.Detail.activity)
        .accessibilityIdentifier("tasks.detail.meta")
        .sheet(isPresented: $showsActivity) {
            TaskActivitySheet(taskId: task.id, taskTitle: task.title, store: store)
        }
    }
}

/// The created / edited / archived stamps.
enum TaskDetailMeta {
    /// An ISO instant (or a bare `YYYY-MM-DD`) as `Jan 14, 2026`.
    static func day(_ stamp: String?) -> String? {
        instant(stamp)?.formatted(.dateTime.month(.abbreviated).day().year())
    }

    static func instant(_ stamp: String?) -> Date? {
        guard let stamp, !stamp.isEmpty else { return nil }
        let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let plain = Date.ISO8601FormatStyle()
        return (try? withFraction.parse(stamp)) ?? (try? plain.parse(stamp)) ?? TaskDates.date(stamp)
    }

    /// "Created Jan 14, 2026 · Edited 2 hours ago · Archived Jan 20, 2026".
    static func line(_ task: TaskItem, now: Date) -> String {
        var parts: [String] = []
        if let created = day(task.createdAt) { parts.append(TasksCopy.Detail.createdOn(created)) }
        if let modified = instant(task.modifiedAt) {
            let relative = modified.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
            parts.append(TasksCopy.Detail.editedAgo(relative))
        }
        if let archived = day(task.archivedAt) { parts.append(TasksCopy.Detail.archivedOn(archived)) }
        return parts.isEmpty ? TasksCopy.Detail.activity : parts.joined(separator: TasksCopy.subtitleSeparator)
    }
}
