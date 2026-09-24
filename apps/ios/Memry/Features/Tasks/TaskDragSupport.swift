import Foundation
import UIKit

// TP050. The pieces the list's drag and drop runs on, after desktop's
// `hooks/use-drag-handlers.ts`, `hooks/use-task-order.ts`,
// `lib/kanban-drop-resolver.ts` and `App.tsx` `handleReorder`.
//
// **Manual order is two things on desktop, and both are kept here.** A drag
// inside a section writes that section's order as `position` 0..n-1 through
// the core (`reorderTasks`), and the same order is remembered device-locally
// per section (`task-orders`) and laid over the core's sorted list. The core
// sorts stably over `position`, so the write alone only wins among sort ties;
// the overlay is what keeps a dragged row where it was dropped.

/// What a dragged row carries: the ids it moves (the selected set when the
/// row is part of it).
enum TaskDragPayload {
    static let prefix = "memry-task-ids:"

    static func encode(_ ids: [String]) -> String {
        prefix + ids.joined(separator: ",")
    }

    /// The ids in a dropped string, or nothing for a foreign string.
    static func decode(_ text: String) -> [String] {
        guard text.hasPrefix(prefix) else { return [] }
        return text.dropFirst(prefix.count).split(separator: ",").map(String.init)
    }
}

/// One row of a list section: a top-level task or a subtask riding under it.
struct TaskListRow: Identifiable, Hashable, Sendable {
    let id: String
    let depth: Int
}

enum TaskReorder {
    /// The section's top-level order after a List move.
    ///
    /// - Parameters:
    ///   - rows: the section's rows as drawn (parents with their subtasks).
    ///   - moving: the dragged row indexes, in `rows`.
    ///   - destination: the index in `rows` the drop lands before.
    ///   - selection: the edit-mode selection; a dragged row inside it moves
    ///     the whole selected set of this section.
    static func topLevelOrder(
        rows: [TaskListRow],
        moving: IndexSet,
        destination: Int,
        selection: Set<String> = []
    ) -> [String] {
        let topLevel = rows.filter { $0.depth == 0 }.map(\.id)
        var moved = moving.compactMap { rows.indices.contains($0) ? rows[$0] : nil }
            .filter { $0.depth == 0 }
            .map(\.id)
        if moved.contains(where: selection.contains) {
            moved = topLevel.filter(selection.contains)
        }
        guard !moved.isEmpty else { return topLevel }
        let movedSet = Set(moved)
        let insertAt = rows.prefix(max(0, min(destination, rows.count)))
            .filter { $0.depth == 0 && !movedSet.contains($0.id) }
            .count
        var order = topLevel.filter { !movedSet.contains($0) }
        order.insert(contentsOf: moved, at: min(insertAt, order.count))
        return order
    }

    /// `App.tsx` `handleReorder`: a section's order written as 0..n-1.
    static func positions(for ids: [String]) -> [Int64] {
        ids.indices.map { Int64($0) }
    }
}

/// The device-local manual order per list section (`use-task-order.ts`,
/// localStorage `task-orders`). Keyed by section as desktop keys them:
/// `flat`, a group key, `done`.
struct TaskListOrders {
    static let key = "task-orders"

    var defaults: UserDefaults = .standard
    /// Scopes the orders to one vault (desktop keeps one vault per window, so
    /// its `task-orders` key needs no scope; the phone switches vaults).
    var vaultId: String?

    private var key: String { vaultId.map { "\(Self.key).\($0)" } ?? Self.key }

    private struct Stored: Codable {
        var orders: [String: [String]] = [:]
    }

    private var stored: Stored {
        guard let data = defaults.data(forKey: key),
              let decoded = try? JSONDecoder().decode(Stored.self, from: data)
        else { return Stored() }
        return decoded
    }

    func order(for section: String) -> [String]? {
        stored.orders[section]
    }

    /// `applyOrderUpdates`: sets each section's order; `nil` forgets it.
    func apply(_ updates: [String: [String]?]) {
        var next = stored
        for (section, order) in updates {
            next.orders[section] = order
        }
        if let data = try? JSONEncoder().encode(next) {
            defaults.set(data, forKey: key)
        }
    }

    /// `getOrderedTasks`: the saved order first, then anything new in the
    /// order it came.
    func ordered(_ ids: [String], section: String) -> [String] {
        guard let saved = order(for: section), !saved.isEmpty else { return ids }
        let present = Set(ids)
        var seen = Set<String>()
        var result: [String] = []
        for id in saved where present.contains(id) && seen.insert(id).inserted {
            result.append(id)
        }
        result += ids.filter { !seen.contains($0) }
        return result
    }
}

/// A due-date group a task can be dropped onto (`dueBucketToDate`). The
/// overdue group is not a target, as on desktop.
enum TaskDueBucket: String, CaseIterable, Sendable {
    case today, tomorrow, upcoming, later, noDueDate

    /// The phrase the core's date parser resolves to desktop's bucket date
    /// (today, +1, +3, +14 days); `nil` clears the date.
    var phrase: String? {
        switch self {
        case .today: "today"
        case .tomorrow: "tomorrow"
        case .upcoming: "in 3 days"
        case .later: "in 14 days"
        case .noDueDate: nil
        }
    }

    var label: String { TasksCopy.dueBucketLabel(rawValue) }

    /// The bucket a date group stands for, when the list is grouped by due date.
    init?(groupKey: String, sortField: String) {
        guard sortField == "dueDate" else { return nil }
        self.init(rawValue: groupKey)
    }
}

/// One List row of the flattened list: a group's header (`row == nil`) or a
/// task row under it. Headers are rows rather than `Section` headers so that
/// one `onMove` sees every destination, including another group: a List moves
/// a row only inside its own `ForEach`, and a cross-section drop never reached
/// a section's `onInsert` or its header's drop target.
struct TaskListFlatItem: Identifiable, Equatable {
    let section: Int
    let row: TaskListRow?
    let sectionId: String

    var id: String { row.map { "row:\($0.id)" } ?? "header:\(sectionId)" }

    /// The sections in list order: each titled section's header, then its rows.
    static func items(_ sections: [TaskListSection]) -> [TaskListFlatItem] {
        sections.enumerated().flatMap { index, section in
            let header = section.title == nil
                ? []
                : [TaskListFlatItem(section: index, row: nil, sectionId: section.id)]
            return header + section.rows.map { TaskListFlatItem(section: index, row: $0, sectionId: section.id) }
        }
    }
}

/// What a List move of the flattened list means.
enum TaskListMove: Equatable {
    /// Inside one section: the section-relative `onMove` arguments.
    case reorder(section: Int, from: IndexSet, to: Int)
    /// Into another due-date group: the moved top-level task ids.
    case reschedule(section: Int, ids: [String])
    /// Headers, subtasks, mixed sections, or a group that takes no drop.
    case none

    static func resolve(
        _ items: [TaskListFlatItem],
        sections: [TaskListSection],
        from source: IndexSet,
        to destination: Int
    ) -> TaskListMove {
        let moved = source.compactMap { items.indices.contains($0) ? items[$0] : nil }
        guard let first = moved.first, moved.allSatisfy({ $0.row != nil && $0.section == first.section }),
              destination > 0, destination <= items.count
        else { return .none }
        let target = items[destination - 1].section
        guard sections.indices.contains(target) else { return .none }
        if target == first.section {
            let rows = sections[target].rows
            let local = IndexSet(moved.compactMap { item in rows.firstIndex { $0.id == item.row?.id } })
            let before = items[..<destination].filter { $0.section == target && $0.row != nil }.count
            return .reorder(section: target, from: local, to: before)
        }
        guard sections[target].dropBucket != nil else { return .none }
        let ids = moved.compactMap { $0.row?.depth == 0 ? $0.row?.id : nil }
        return ids.isEmpty ? .none : .reschedule(section: target, ids: ids)
    }

}
