import MemryCore
import SwiftUI

// TP047. The bulk bar's menus (`bulk-action-toolbar.tsx`): priority, due
// date, move to project, status. Each write clears the selection once it
// landed (desktop's `onComplete: deselectAll`).

/// Runs a bulk write and clears the written ids from the selection after it
/// succeeded.
@MainActor
struct TaskSelectionWrite {
    let store: TasksStore
    let selection: Binding<Set<String>>

    func callAsFunction(_ write: @escaping @MainActor (Set<String>) async -> Bool) {
        let chosen = selection.wrappedValue
        Task { @MainActor in
            if await write(chosen) { selection.wrappedValue.subtract(chosen) }
        }
    }
}

/// Urgent, High, Medium, Low, Remove priority.
struct TaskBulkPriorityMenu: View {
    let store: TasksStore
    let write: TaskSelectionWrite

    var body: some View {
        Menu {
            ForEach([Int64(4), 3, 2, 1], id: \.self) { value in
                Button {
                    write { await store.setPriority(of: $0, to: value) }
                } label: {
                    Label(TasksCopy.priorityLabel(value), systemImage: "flag.fill")
                }
                .accessibilityIdentifier("tasks.bulk.priority.\(value)")
            }
            Divider()
            Button(TasksCopy.removePriority, systemImage: "flag.slash") {
                write { await store.setPriority(of: $0, to: 0) }
            }
            .accessibilityIdentifier("tasks.bulk.priority.0")
        } label: {
            TaskBulkActionLabel(title: TasksCopy.bulkPriority, systemImage: "flag")
        }
        .accessibilityIdentifier("tasks.bulk.priority")
    }
}

/// Today, Tomorrow, Next week, Next month, Pick a date..., Remove due date.
struct TaskBulkDueMenu: View {
    let store: TasksStore
    let write: TaskSelectionWrite
    let pickDate: () -> Void

    var body: some View {
        Menu {
            ForEach(TaskBulkDuePreset.allCases, id: \.self) { preset in
                Button(preset.title, systemImage: "calendar") {
                    write { await store.setDue(of: $0, preset: preset) }
                }
                .accessibilityIdentifier("tasks.bulk.due.\(preset.rawValue)")
            }
            Divider()
            Button(TasksCopy.duePickDate, systemImage: "calendar.badge.plus", action: pickDate)
                .accessibilityIdentifier("tasks.bulk.due.pick")
            Divider()
            Button(TasksCopy.dueRemove, systemImage: "calendar.badge.minus") {
                write { await store.setDue(of: $0, date: nil, time: nil) }
            }
            .accessibilityIdentifier("tasks.bulk.due.remove")
        } label: {
            TaskBulkActionLabel(title: TasksCopy.bulkDate, systemImage: "calendar")
        }
        .accessibilityIdentifier("tasks.bulk.due")
    }
}

/// Every live project, Inbox included.
struct TaskBulkMoveMenu: View {
    let store: TasksStore
    let write: TaskSelectionWrite

    var body: some View {
        Menu {
            ForEach(store.bulkMoveTargets, id: \.id) { project in
                Button {
                    write { await store.move($0, to: project) }
                } label: {
                    Label(project.name, systemImage: project.isInbox ? "tray" : "folder")
                }
                .accessibilityIdentifier("tasks.bulk.move.\(project.id)")
            }
        } label: {
            TaskBulkActionLabel(title: TasksCopy.bulkMove, systemImage: "folder")
        }
        .accessibilityIdentifier("tasks.bulk.move")
    }
}

/// The statuses of the one project the whole selection shares.
struct TaskBulkStatusMenu: View {
    let store: TasksStore
    let statuses: [StatusItem]
    let write: TaskSelectionWrite

    var body: some View {
        Menu {
            ForEach(statuses, id: \.id) { status in
                Button {
                    write { await store.setStatus(of: $0, to: status) }
                } label: {
                    Label(status.name, systemImage: symbol(status))
                }
                .accessibilityIdentifier("tasks.bulk.status.\(status.id)")
            }
        } label: {
            TaskBulkActionLabel(title: TasksCopy.bulkStatus, systemImage: "square.split.3x1")
        }
        .accessibilityIdentifier("tasks.bulk.status")
    }

    private func symbol(_ status: StatusItem) -> String {
        switch status.statusType {
        case "done": "checkmark.circle"
        case "in_progress": "circle.lefthalf.filled"
        default: "circle"
        }
    }
}
