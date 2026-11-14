import MemryCore
import SwiftUI

// #4357. A task dropped on a day: a Month cell, a Week or Day column, or a day
// of the Journal rail's month. The drop sets the task's due date to that day
// and keeps its time, through the write the calendar's own date controls make
// (`CalendarStore.taskWrite` with `setDue`), Undo included. The drag carries
// the payloads the Tasks drops already read: a task row's `TaskDragPayload`
// or a kanban card's bare id. The grid's hold-drag (#4620) is a gesture, not
// a drag session, so the two never meet.

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

    /// Sets each task's due date to `day`, keeping its time. A task already
    /// due that day is left as it is.
    func dateTasks(_ ids: [String], to day: String) async {
        guard let tasks else { return }
        for id in ids {
            guard let task = tasks.items[id], task.dueDate != day else { continue }
            let time = task.dueTime
            await taskWrite(id, message: CalendarCopy.taskRescheduled) { core, id in
                try core.setDue(id: id, date: day, time: time)
            }
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
            content.draggable(TaskDragPayload.encode([id]))
        } else {
            content
        }
    }
}
