import MemryCore
import SwiftUI

// TP049. The kanban board's shapes, after desktop's `kanban-columns.ts`
// (`KanbanColumnDef`, `ColumnMode`) and `kanban-drop-resolver.ts`
// (`ColumnDropResult`). A column says what dropping a task on it writes; the
// store extension (`TasksStore+Kanban.swift`) does the writing.

/// What the board's columns are (`TasksViewState.kanbanColumns`).
enum KanbanColumnMode: String, CaseIterable, Sendable, Identifiable {
    /// To Do / In Progress / Done, by each task's status type.
    case canonical
    /// The selected project's own statuses; canonical with no single project.
    case status
    case priority
    case dueDate
    case project

    var id: String { rawValue }

    /// The modes the picker offers. Canonical is what `status` shows without
    /// a project, as on desktop, not a choice of its own.
    static let pickable: [KanbanColumnMode] = [.status, .priority, .dueDate, .project]

    /// A stored value this build does not know reads as `status`.
    init(stored: String) {
        self = KanbanColumnMode(rawValue: stored) ?? .status
    }
}

/// What a column stands for, and so what a drop on it writes.
enum KanbanTarget: Equatable, Sendable {
    /// `todo`, `in_progress` or `done` across projects: each task takes its
    /// own project's first status of that type.
    case statusType(String)
    /// One status of one project.
    case status(id: String, name: String, type: String, projectId: String)
    /// 0 none .. 4 urgent.
    case priority(Int64)
    /// A due bucket key: `overdue`, `today`, `tomorrow`, `upcoming`, `later`,
    /// `noDueDate` (the core's due-date group keys).
    case due(String)
    case project(id: String, name: String)
}

/// One column of the board.
struct KanbanColumn: Identifiable, Equatable, Sendable {
    /// Desktop's column id (`todo`, a status id, `priority-high`,
    /// `due-today`, `project-<id>`).
    let id: String
    let title: String
    let target: KanbanTarget
    /// A stored `#rrggbb` (status, project) the header dot paints.
    var color: String?

    /// Desktop's `column.statusType === 'done'`: the column that folds its
    /// cards after the first few and offers no add.
    var isDoneColumn: Bool {
        switch target {
        case let .statusType(type): type == "done"
        case let .status(_, _, type, _): type == "done"
        default: false
        }
    }

    /// Whether a card can be moved here. Not onto Overdue: that would clear
    /// the date ("Rescheduled to No Due Date"), which is not what the column
    /// says; the list's drop targets exclude Overdue for the same reason.
    var acceptsMove: Bool {
        if case .due("overdue") = target { return false }
        return true
    }

    /// Whether the column offers "+". Not on a done column (desktop), and
    /// not on Overdue, whose drop and add would clear the date.
    var acceptsAdd: Bool {
        if isDoneColumn { return false }
        if case .due("overdue") = target { return false }
        return true
    }

    /// The empty state's two lines.
    var emptyCopy: (title: String, subtitle: String) {
        if isDoneColumn { return (TasksCopy.kanbanEmptyDoneTitle, TasksCopy.kanbanEmptyDoneSubtitle) }
        if case .due = target {
            return (TasksCopy.kanbanEmptyScheduleTitle, TasksCopy.kanbanEmptyScheduleSubtitle)
        }
        return (TasksCopy.kanbanEmptyTitle, TasksCopy.kanbanEmptySubtitle)
    }

    /// The header mark's colour: priority and due columns use the task
    /// tokens, status and project columns their stored colour.
    var tint: Color {
        switch target {
        case let .priority(value):
            return value == 0 ? Tokens.Text.tertiary.color : Tokens.Task.priority(value).color
        case let .due(bucket):
            switch bucket {
            case "overdue": return Tokens.Task.dueOverdue.color
            case "today": return Tokens.Task.dueToday.color
            case "tomorrow": return Tokens.Task.dueTomorrow.color
            case "upcoming": return Tokens.Task.dueUpcoming.color
            default: return Tokens.Text.tertiary.color
            }
        case .statusType, .status, .project:
            return color.map { Tokens.Palette.color($0) } ?? Tokens.Text.tertiary.color
        }
    }
}

/// A column with the cards it holds, in the page's order.
struct KanbanLane: Identifiable, Equatable, Sendable {
    let column: KanbanColumn
    let tasks: [TaskItem]

    var id: String { column.id }
}
