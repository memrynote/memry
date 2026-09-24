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

    static func itemProvider(_ ids: [String]) -> NSItemProvider {
        NSItemProvider(object: encode(ids) as NSString)
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

    private struct Stored: Codable {
        var orders: [String: [String]] = [:]
    }

    private var stored: Stored {
        guard let data = defaults.data(forKey: Self.key),
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
            defaults.set(data, forKey: Self.key)
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
