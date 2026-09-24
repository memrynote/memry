import Foundation
@testable import Memry
import Testing

/// TP050: one `onMove` over the flattened list decides between a reorder
/// inside a group and a reschedule into another due-date group.
@Suite("Task list moves")
struct TasksListMoveTests {
    private func section(_ id: String, rows: [String], bucket: Bool, titled: Bool = true) -> TaskListSection {
        TaskListSection(
            id: id,
            kind: .group,
            title: titled ? id : nil,
            color: nil,
            count: rows.count,
            isCollapsed: false,
            dropBucket: bucket ? TaskDueBucket(groupKey: id, sortField: "dueDate") : nil,
            rows: rows.map { TaskListRow(id: $0, depth: $0.hasPrefix("sub") ? 1 : 0) }
        )
    }

    /// today: [h, a, b, sub1] tomorrow: [h, c] done: [h, d]
    private var sections: [TaskListSection] {
        [
            section("today", rows: ["a", "b", "sub1"], bucket: true),
            section("tomorrow", rows: ["c"], bucket: true),
            section("done", rows: ["d"], bucket: false)
        ]
    }

    @Test func headers_are_rows_before_their_section() {
        let items = TaskListFlatItem.items(sections)
        #expect(items.map(\.id) == [
            "header:today", "row:a", "row:b", "row:sub1",
            "header:tomorrow", "row:c",
            "header:done", "row:d"
        ])
        let flat = TaskListFlatItem.items([section("flat", rows: ["x"], bucket: false, titled: false)])
        #expect(flat.map(\.id) == ["row:x"])
    }

    @Test func a_move_inside_a_group_is_a_section_relative_reorder() {
        let items = TaskListFlatItem.items(sections)
        // b (flat 2) above a (flat 1): destination 1 -> section index 0.
        #expect(TaskListMove.resolve(items, sections: sections, from: [2], to: 1)
            == .reorder(section: 0, from: [1], to: 0))
        // a to the end of today, just above tomorrow's header.
        #expect(TaskListMove.resolve(items, sections: sections, from: [1], to: 4)
            == .reorder(section: 0, from: [0], to: 3))
    }

    @Test func a_move_into_another_date_group_reschedules_there() {
        let items = TaskListFlatItem.items(sections)
        // a under tomorrow's header, and a below c.
        let intoTomorrow = TaskListMove.reschedule(section: 1, ids: ["a"])
        #expect(TaskListMove.resolve(items, sections: sections, from: [1], to: 5) == intoTomorrow)
        #expect(TaskListMove.resolve(items, sections: sections, from: [1], to: 6) == intoTomorrow)
    }

    @Test func done_headers_top_and_subtasks_take_nothing() {
        let items = TaskListFlatItem.items(sections)
        #expect(TaskListMove.resolve(items, sections: sections, from: [1], to: 8) == .none)
        #expect(TaskListMove.resolve(items, sections: sections, from: [0], to: 5) == .none)
        #expect(TaskListMove.resolve(items, sections: sections, from: [5], to: 0) == .none)
        #expect(TaskListMove.resolve(items, sections: sections, from: [3], to: 6) == .none)
    }
}
