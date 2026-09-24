import Foundation
import MemryCore
import Testing

@testable import Memry

// RD01p: the redesign's primitives — which status glyph, how full the
// priority bars, how a due date reads when the screen already names the day,
// and what a row's one meta line holds (Paper artboard 00, rule 4).

@MainActor
@Suite("Task primitives")
struct TasksPrimitivesTests {
    private let today = "2026-01-14"

    @Test func status_glyphs_follow_the_status_type() {
        #expect(TaskStatusGlyph.symbol(statusType: "todo", isDone: false) == "circle.dashed")
        #expect(TaskStatusGlyph.symbol(statusType: nil, isDone: false) == "circle.dashed")
        #expect(TaskStatusGlyph.symbol(statusType: "in_progress", isDone: false) == "circle.lefthalf.filled")
        #expect(TaskStatusGlyph.symbol(statusType: "done", isDone: true) == "checkmark.circle.fill")
        // A done task reads done whatever its stored type says.
        #expect(TaskStatusGlyph.symbol(statusType: "todo", isDone: true) == "checkmark.circle.fill")
    }

    @Test func priority_bars_fill_a_quarter_per_level() {
        #expect(TaskPriorityBars.fill(0) == 0)
        #expect(TaskPriorityBars.fill(1) == 0.25)
        #expect(TaskPriorityBars.fill(3) == 0.75)
        #expect(TaskPriorityBars.fill(4) == 1)
        // A value from a newer build is clamped, never drawn past full.
        #expect(TaskPriorityBars.fill(9) == 1)
    }

    @Test func a_due_label_drops_its_day_where_the_screen_names_it() throws {
        let timed = try #require(TaskDueLabel.make(date: today, time: "15:00", today: today, isDone: false))
        #expect(timed.day == "Today")
        #expect(timed.text(omittingDay: false)?.hasPrefix("Today ") == true)
        #expect(timed.text(omittingDay: true) == timed.time)
        let untimed = try #require(TaskDueLabel.make(date: today, time: nil, today: today, isDone: false))
        #expect(untimed.text(omittingDay: true) == nil)
        let yesterday = try #require(TaskDueLabel.make(date: "2026-01-13", time: nil, today: today, isDone: false))
        #expect(yesterday.text == "Yesterday")
        #expect(yesterday.tone == .overdue)
    }

    @Test func repeat_progress_reads_only_for_a_counted_series() {
        let counted = RepeatRule(
            frequency: "daily", interval: 1, daysOfWeek: nil, monthlyType: nil, dayOfMonth: nil,
            weekOfMonth: nil, dayOfWeekForMonth: nil, endType: "count", endDate: nil, endCount: 10,
            completedCount: 2, createdAt: nil
        )
        #expect(TaskRepeatProgress.text(counted) == "3/10")
        let endless = RepeatRule(
            frequency: "daily", interval: 1, daysOfWeek: nil, monthlyType: nil, dayOfMonth: nil,
            weekOfMonth: nil, dayOfWeekForMonth: nil, endType: "never", endDate: nil, endCount: nil,
            completedCount: 2, createdAt: nil
        )
        #expect(TaskRepeatProgress.text(endless) == nil)
        #expect(TaskRepeatProgress.text(nil) == nil)
    }

    @Test func the_meta_line_keeps_desktops_order_and_drops_what_the_screen_says() throws {
        let due = TaskDueLabel.make(date: today, time: "15:00", today: today, isDone: false)
        let project = Self.project(name: "Launch", isInbox: false)
        let full = TaskMeta.make(
            due: due, rule: nil, isRepeating: true, subtasks: (2, 5), notes: 1, project: project,
            context: TaskMeta.Context()
        )
        #expect(full.items.count == 5)
        guard case .due = full.items[0], case .repeats = full.items[1], case .subtasks = full.items[2],
              case .notes = full.items[3], case .project = full.items[4] else {
            Issue.record("meta order is date, repeat, subtasks, note, project: \(full.items)")
            return
        }

        // In a Today group: the time only; in a project scope: no project.
        let scoped = TaskMeta.make(
            due: due, rule: nil, isRepeating: false, subtasks: (0, 0), notes: 0, project: project,
            context: TaskMeta.Context(omitsDay: true, showsProject: false)
        )
        #expect(scoped.items == [.due(text: try #require(due?.time), tone: .today)])

        // The Inbox is never named, and an untimed task in its own day shows nothing.
        let inbox = TaskMeta.make(
            due: TaskDueLabel.make(date: today, time: nil, today: today, isDone: false),
            rule: nil, isRepeating: false, subtasks: (0, 0), notes: 0,
            project: Self.project(name: "Inbox", isInbox: true),
            context: TaskMeta.Context(omitsDay: true)
        )
        #expect(inbox.isEmpty)
    }

    @Test func an_overdue_date_shows_even_in_a_view_about_today() {
        let overdue = TaskDueLabel.make(date: "2026-01-10", time: nil, today: today, isDone: false)
        let meta = TaskMeta.make(
            due: overdue, rule: nil, isRepeating: false, subtasks: (0, 0), notes: 0, project: nil,
            context: TaskMeta.Context(omitsDay: true)
        )
        #expect(meta.items == [.due(text: "Jan 10", tone: .overdue)])
    }

    private static func project(name: String, isInbox: Bool) -> ProjectItem {
        ProjectItem(
            id: isInbox ? "inbox" : "p1", name: name, description: nil, color: "#8A7CD6", icon: nil,
            position: 0, isInbox: isInbox, archivedAt: nil, homeNoteId: nil, statuses: []
        )
    }
}
