import MemryCore
import SwiftUI

// TP043. The detail's footer, after the drawer's: unarchive (the way back out
// of the archive, `task-unarchive-button.tsx`), delete behind desktop's
// confirmation (`delete-task-dialog.tsx`), and when the task was created and
// archived.

struct TaskDetailFooter: View {
    let task: TaskItem
    let store: TasksStore
    let onDelete: (TaskItem) -> Void

    @State private var confirmingDelete = false

    var body: some View {
        Section {
            if task.archivedAt != nil {
                Button {
                    Task { await store.detailUnarchive(task) }
                } label: {
                    Label(TasksCopy.Detail.unarchive, systemImage: "arrow.uturn.backward")
                        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
                        .contentShape(.rect)
                }
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityIdentifier("tasks.detail.unarchive")
            }
            Button(role: .destructive) {
                confirmingDelete = true
            } label: {
                Label(TasksCopy.Detail.deleteTask, systemImage: "trash")
                    .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
                    .contentShape(.rect)
            }
            .foregroundStyle(Tokens.Interaction.destructive.color)
            .accessibilityIdentifier("tasks.detail.delete")
        } footer: {
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                if let created = TaskDetailMeta.day(task.createdAt) {
                    Text(TasksCopy.Detail.createdOn(created))
                }
                if let archived = TaskDetailMeta.day(task.archivedAt) {
                    Text(TasksCopy.Detail.archivedOn(archived))
                }
            }
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.tertiary.color)
            .accessibilityIdentifier("tasks.detail.meta")
        }
        .alert(TasksCopy.Detail.deleteTaskQuestion, isPresented: $confirmingDelete) {
            Button(TasksCopy.Detail.cancel, role: .cancel) {}
            Button(TasksCopy.Detail.deleteTaskConfirm, role: .destructive) {
                onDelete(task)
            }
            .accessibilityIdentifier("tasks.detail.deleteConfirm")
        } message: {
            Text(TasksCopy.Detail.deleteConfirmBody(task.title))
        }
    }
}

/// The created/archived stamps as a short date.
enum TaskDetailMeta {
    /// An ISO instant (or a bare `YYYY-MM-DD`) as `Jan 14, 2026`.
    static func day(_ stamp: String?) -> String? {
        guard let stamp, !stamp.isEmpty else { return nil }
        let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let plain = Date.ISO8601FormatStyle()
        let date = (try? withFraction.parse(stamp)) ?? (try? plain.parse(stamp)) ?? TaskDates.date(stamp)
        return date?.formatted(.dateTime.month(.abbreviated).day().year())
    }
}
