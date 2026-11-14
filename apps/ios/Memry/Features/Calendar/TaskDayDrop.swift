import CoreTransferable
import MemryCore
import SwiftUI
import UniformTypeIdentifiers

// #4357. A task dropped on a day: a Month cell, a Week or Day column, or a day
// of the Journal rail's month. The drop sets the task's due date to that day
// and keeps its time, through the write the calendar's own date controls make
// (`CalendarStore.tasksWrite`, under `taskWrite`, with `bulkSetDue`), Undo
// included. The drag carries the payloads the Tasks drops already read: a
// task row's `TaskDragPayload` or a kanban card's bare id. The grid's hold-drag (#4620) is a gesture, not
// a drag session, so the two never meet.

extension UTType {
    /// Task ids dragged out of a task row, so a target that takes text (the
    /// Inbox) can tell a task drag from text before it loads. Exported in
    /// `Info.plist`.
    static let memryTasks = UTType(exportedAs: "com.memrynote.app.tasks")
}

/// A task row's drag: the private type, then the `TaskDragPayload` text the
/// task drops read.
struct TaskDrag: Transferable, Sendable {
    let ids: [String]

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .memryTasks) { Data(TaskDragPayload.encode($0.ids).utf8) }
            .visibility(.ownProcess)
        ProxyRepresentation { TaskDragPayload.encode($0.ids) }
    }
}

enum TaskDayDrop {
    /// The task ids in dropped strings: a task row's payload, or a kanban
    /// card's bare id when it names a task. Anything else (a note's text, a
    /// link) names none.
    static func ids(in texts: [String], isTask: (String) -> Bool) -> [String] {
        var ids: [String] = []
        for text in texts {
            let decoded = TaskDragPayload.decode(text)
            for id in decoded.isEmpty ? [text] : decoded where isTask(id) && !ids.contains(id) {
                ids.append(id)
            }
        }
        return ids
    }
}

extension CalendarStore {
    /// The tasks among dropped strings that this vault holds.
    func droppedTaskIds(_ texts: [String]) -> [String] {
        guard let tasks else { return [] }
        return TaskDayDrop.ids(in: texts) { tasks.items[$0] != nil }
    }

    /// Sets each task's due date to `day`, keeping its time, as one write
    /// with one toast and one Undo. A task already due that day is left as it
    /// is. The core writes date and time together, so tasks sharing a time go
    /// in one call (`TasksStore.reschedule` does the same).
    func dateTasks(_ ids: [String], to day: String) async {
        guard let tasks else { return }
        let moving = ids.compactMap { tasks.items[$0] }.filter { $0.dueDate != day }
        guard !moving.isEmpty else { return }
        let batches = Dictionary(grouping: moving, by: \.dueTime).map { time, tasks in (time, tasks.map(\.id)) }
        let message = moving.count == 1 ? CalendarCopy.taskRescheduled : CalendarCopy.tasksRescheduled(moving.count)
        await tasksWrite(message: message) { core in
            var merged: TaskChange?
            for (time, batch) in batches {
                merged = TasksStore.merge(merged, try core.bulkSetDue(ids: batch, date: day, time: time))
            }
            return TasksStore.merge(merged, nil)
        }
    }
}

/// A day that takes dropped tasks; the tint outlines it while one hovers.
struct TaskDayDropTarget: ViewModifier {
    let day: String

    @Environment(\.calendarStore) private var store
    @State private var isTargeted = false

    func body(content: Content) -> some View {
        content
            .overlay {
                if isTargeted {
                    RoundedRectangle(cornerRadius: Tokens.Radius.small)
                        .strokeBorder(Tokens.Tint.base.color, lineWidth: 2)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .dropDestination(for: String.self) { texts, _ in
                guard let store else { return false }
                let ids = store.droppedTaskIds(texts)
                guard !ids.isEmpty else { return false }
                Task { await store.dateTasks(ids, to: day) }
                return true
            } isTargeted: { isTargeted = $0 && store != nil }
    }
}

/// A task row that drags its id to a day or a due-date group. Regular width
/// only: compact width, every iPhone among it, keeps the row as it was.
struct TaskDragSource: ViewModifier {
    /// `nil` for a row that is not a task.
    let id: String?

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    func body(content: Content) -> some View {
        if let id, LayoutWidth(horizontal: horizontalSizeClass, vertical: verticalSizeClass) == .regular {
            content.draggable(TaskDrag(ids: [id]))
        } else {
            content
        }
    }
}
