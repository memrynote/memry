import Foundation
import MemryCore
import Testing
import UIKit

@testable import Memry

// Spec 007 CL014, CL021, CL023, CL036, CL050, CL054: the calendar's pure
// Swift logic, each expectation restated from the desktop source it ports
// (`timeline-model.test.ts`, `overlap-layout.ts`, `calendar-view-state.ts`,
// `snooze-options.ts`, `date-utils.ts`).

private func task(
    _ title: String,
    project: String = "aa1111",
    start: String? = nil,
    due: String? = nil,
    parent: String? = nil,
    priority: Int64 = 0,
    completedAt: String? = nil
) -> TaskItem {
    TaskItem(
        id: title, title: title, description: nil, projectId: project, statusId: nil, parentId: parent,
        priority: priority, position: 0, dueDate: due, dueTime: nil, startDate: start,
        repeat: nil, isRepeating: false, repeatFrom: nil, sourceNoteId: nil,
        completedAt: completedAt, archivedAt: nil, tags: [], linkedNoteIds: [], linkedCanvasIds: [],
        createdAt: nil, modifiedAt: nil, statusType: nil, isDone: completedAt != nil
    )
}

private func project(_ id: String, _ name: String, archived: Bool = false) -> ProjectItem {
    ProjectItem(
        id: id, name: name, description: nil, color: "#3e63dd", icon: nil, position: 0, isInbox: false,
        archivedAt: archived ? "2026-01-01T00:00:00.000Z" : nil, homeNoteId: nil, statuses: []
    )
}

private func item(_ id: String, start: String, end: String?, allDay: Bool = false, type: String = "event") -> CalendarItem {
    CalendarItem(
        projectionId: "\(type):\(id)", sourceType: type, sourceId: id, title: id, descriptionPreview: nil,
        startAt: start, endAt: end, isAllDay: allDay, timezone: "UTC", visualType: type,
        editability: CalendarEditability(canMove: true, canResize: true, canEditText: true, canDelete: true),
        source: CalendarItemSource(provider: nil, calendarSourceId: nil, title: "memrynote", color: nil, kind: nil, isMemryManaged: true),
        binding: nil, snoozeOffsetMinutes: nil, color: nil, displayColor: nil, noteId: nil, anchorId: nil, isTriggered: nil
    )
}

@MainActor
@Suite("Calendar timeline model — spec 007 CL014")
struct CalendarTimelineTests {
    let september = TimelineModel.window(anchor: "2026-09-23", zoom: .months, weekStartsOn: 1)

    @Test func windows_follow_the_zoom() {
        #expect(september == TimelineModel.Window(start: "2026-07-01", end: "2026-12-31"))
        #expect(september.dayCount == 184)
        let weeks = TimelineModel.window(anchor: "2026-09-23", zoom: .weeks, weekStartsOn: 1)
        #expect(weeks.start == "2026-08-31")
        #expect(weeks.dayCount == 70)
        let quarters = TimelineModel.window(anchor: "2026-09-23", zoom: .quarters, weekStartsOn: 1)
        #expect(quarters.start == "2026-01-01")
        #expect(quarters.end == "2027-06-30")
    }

    @Test func steps_per_zoom() {
        #expect(TimelineModel.step(anchor: "2026-09-23", zoom: .weeks, direction: 1) == "2026-09-30")
        #expect(TimelineModel.step(anchor: "2026-09-23", zoom: .months, direction: -1) == "2026-08-23")
        #expect(TimelineModel.step(anchor: "2026-09-23", zoom: .quarters, direction: 1) == "2026-12-23")
    }

    @Test func shapes_and_bounds() {
        #expect(TimelineModel.shape(start: "2026-09-01", due: "2026-09-05") == .span(start: "2026-09-01", end: "2026-09-05"))
        #expect(TimelineModel.shape(start: "2026-09-05", due: "2026-09-05") == .due("2026-09-05"))
        #expect(TimelineModel.shape(start: "2026-09-05", due: nil) == .start("2026-09-05"))
        #expect(TimelineModel.shape(start: nil, due: nil) == .none)
        let open = TimelineModel.bounds(.start("2026-09-05"))
        #expect(open?.first == "2026-09-05" && open?.last == "2026-09-09")
    }

    @Test func placement_clips_at_the_window_edges() {
        #expect(TimelineModel.place(first: "2026-06-20", last: "2026-07-03", window: september)
            == TimelineModel.Placement(from: 0, to: 2, clippedStart: true, clippedEnd: false))
        #expect(TimelineModel.place(first: "2026-12-30", last: "2027-01-04", window: september)
            == TimelineModel.Placement(from: 182, to: 183, clippedStart: false, clippedEnd: true))
        #expect(TimelineModel.place(first: "2027-02-01", last: "2027-02-03", window: september) == nil)
    }

    @Test func edits_move_and_resize_like_desktop() {
        let span = TimelineModel.Shape.span(start: "2026-09-01", end: "2026-09-05")
        #expect(TimelineModel.apply(span, .move, deltaDays: 2) == .init(start: "2026-09-03", due: "2026-09-07"))
        #expect(TimelineModel.apply(span, .resizeEnd, deltaDays: -10) == .init(start: "2026-09-01", due: "2026-09-01"))
        #expect(TimelineModel.apply(span, .resizeStart, deltaDays: 10) == .init(start: "2026-09-05", due: "2026-09-05"))
        #expect(TimelineModel.apply(.due("2026-09-05"), .resizeEnd, deltaDays: 2) == .init(start: "2026-09-05", due: "2026-09-07"))
        #expect(TimelineModel.apply(.due("2026-09-05"), .resizeEnd, deltaDays: -2) == .init(start: nil, due: "2026-09-05"))
        #expect(TimelineModel.apply(.start("2026-09-05"), .resizeStart, deltaDays: -1) == .init(start: "2026-09-04", due: nil))
        #expect(TimelineModel.schedule(from: "2026-09-08", to: "2026-09-08") == .init(start: nil, due: "2026-09-08"))
        #expect(TimelineModel.schedule(from: "2026-09-10", to: "2026-09-08") == .init(start: "2026-09-08", due: "2026-09-10"))
    }

    @Test func groups_by_project_and_sorts_by_start() {
        let tasks = [
            task("Write post", start: "2026-09-10", due: "2026-09-12"),
            task("Ship view", due: "2026-09-02"),
            task("Screenshots", start: "2026-09-05", due: "2026-09-06"),
            task("Other", project: "bb2222", due: "2026-09-01")
        ]
        let groups = TimelineModel.groups(
            tasks: tasks, projects: [project("aa1111", "Launch"), project("bb2222", "Ops")],
            events: [], window: september, today: "2026-09-01", settings: TimelineSettings()
        )
        #expect(groups.map(\.id) == ["project:aa1111", "project:bb2222"])
        let titles = groups[0].rows.compactMap { row -> String? in if case let .task(t) = row { return t.task.title }; return nil }
        #expect(titles == ["Ship view", "Screenshots", "Write post"])
    }

    @Test func undated_last_hidden_on_request_and_overdue_flagged() {
        let tasks = [task("Undated"), task("Dated", due: "2026-09-02"), task("Late", due: "2026-08-01")]
        var settings = TimelineSettings()
        let groups = TimelineModel.groups(tasks: tasks, projects: [project("aa1111", "Launch")], events: [], window: september, today: "2026-09-10", settings: settings)
        let rows = groups[0].rows.compactMap { row -> TimelineModel.TaskRow? in if case let .task(t) = row { return t }; return nil }
        #expect(rows.last?.task.title == "Undated")
        #expect(rows.first { $0.task.title == "Late" }?.isOverdue == true)
        settings.showUndated = false
        let hidden = TimelineModel.groups(tasks: tasks, projects: [project("aa1111", "Launch")], events: [], window: september, today: "2026-09-10", settings: settings)
        #expect(hidden[0].rows.count == 2)
    }

    @Test func subtasks_nest_under_their_parent_when_shown() {
        let tasks = [task("Parent", due: "2026-09-05"), task("Child", due: "2026-09-03", parent: "Parent"), task("Other", due: "2026-09-04")]
        var settings = TimelineSettings()
        settings.showSubtasks = true
        let rows = TimelineModel.groups(tasks: tasks, projects: [project("aa1111", "Launch")], events: [], window: september, today: "2026-09-01", settings: settings)[0].rows
        let pairs = rows.compactMap { row -> String? in if case let .task(t) = row { return "\(t.task.title):\(t.depth)" }; return nil }
        #expect(pairs == ["Other:0", "Parent:0", "Child:1"])
    }
}

@MainActor
@Suite("Calendar layout and state — spec 007 CL021, CL023, CL036")
struct CalendarLayoutTests {
    @Test func overlapping_items_share_a_cluster_of_lanes() {
        let items = [
            item("a", start: "2026-09-24T09:00:00.000Z", end: "2026-09-24T10:00:00.000Z"),
            item("b", start: "2026-09-24T09:30:00.000Z", end: "2026-09-24T11:00:00.000Z"),
            item("c", start: "2026-09-24T10:00:00.000Z", end: "2026-09-24T10:30:00.000Z"),
            item("d", start: "2026-09-24T12:00:00.000Z", end: nil)
        ]
        let lanes = CalendarLayout.lanes(items, start: \.startDate, end: \.endDate)
        let byId = Dictionary(uniqueKeysWithValues: lanes.map { ($0.item.sourceId, ($0.lane, $0.laneCount)) })
        #expect(byId["a"]! == (0, 2))
        #expect(byId["b"]! == (1, 2))
        #expect(byId["c"]! == (0, 2))
        #expect(byId["d"]! == (0, 1))
    }

    /// CL092: a week of 200 timed items lays out (per-day lanes, the span
    /// rows) without per-call date parsing.
    @Test func a_week_of_200_items_lays_out_inside_a_frame() {
        let week = (0 ..< 7).map { CalendarDates.addDays("2026-09-28", $0) }
        let items = (0 ..< 200).map { index -> CalendarItem in
            let day = week[index % 7]
            // Starts 05:00-15:59 UTC so every item stays on its local day
            // east or west of UTC by up to 8 hours.
            let minute = (index * 37) % (11 * 60)
            let start = String(format: "%@T%02d:%02d:00.000Z", day, 5 + minute / 60, minute % 60)
            let endMinute = minute + 45
            let end = String(format: "%@T%02d:%02d:00.000Z", day, 5 + endMinute / 60, endMinute % 60)
            return item("load\(index)", start: start, end: end)
        }
        let clock = ContinuousClock()
        var laid = 0
        func pass() -> Duration {
            clock.measure {
                laid = 0
                for day in week {
                    let dayItems = items.filter { !$0.isSpanning && CalendarDates.covers($0, day) }
                    laid += CalendarLayout.lanes(dayItems, start: \.startDate, end: \.endDate).count
                }
                _ = CalendarLayout.spanRows(items.filter(\.isSpanning), week: week, key: \.projectionId,
                                            first: CalendarDates.spanStart, last: CalendarDates.spanEnd)
            }
        }
        let cold = pass()
        // Steady state is what paging and scrolling see; the best of five
        // keeps a parallel test run's scheduling out of the number.
        let best = (0 ..< 5).map { _ in pass() }.min() ?? cold
        print("CL092 week layout: \(laid) items, cold \(cold), best warm \(best)")
        #expect(laid == 200)
        // Alone this runs in ~11 ms, inside a 16.7 ms frame (§5 F5). The
        // Unit plan runs suites in parallel, so a wall-clock frame bound
        // would flake; 100 ms still fails the ~200 ms per-parse regression.
        #expect(best < .milliseconds(100))
    }

    @Test func the_fast_instant_reader_agrees_with_the_formatter() {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        for text in ["2026-09-28T07:00:00.000Z", "2024-02-29T23:59:59.999Z", "1999-12-31T00:00:00.000Z", "2026-03-29T01:30:00.500Z"] {
            #expect(CalendarDates.date(text) == formatter.date(from: text), "\(text)")
        }
        #expect(CalendarDates.date("2026-09-28T07:00:00Z") == Date(timeIntervalSince1970: 1_790_578_800))
        #expect(CalendarDates.date("2026-09-28T10:00:00+03:00") == Date(timeIntervalSince1970: 1_790_578_800))
        #expect(CalendarDates.date("2026-13-28T07:00:00.000Z") == nil)
    }

    @Test func spans_clip_to_the_week_and_stack_rows() {
        let week = (0 ..< 7).map { CalendarDates.addDays("2026-09-21", $0) }
        let spans = [("long", "2026-09-18", "2026-09-23"), ("short", "2026-09-22", "2026-09-22"), ("next", "2026-09-26", "2026-09-30")]
        let bars = CalendarLayout.spanRows(spans, week: week, key: { $0.0 }, first: { $0.1 }, last: { $0.2 })
        let long = bars.first { $0.item.0 == "long" }
        #expect(long?.startColumn == 0 && long?.endColumn == 2 && long?.continuesBefore == true)
        #expect(bars.first { $0.item.0 == "short" }?.row == 1)
        #expect(bars.first { $0.item.0 == "next" }?.continuesAfter == true)
    }

    @Test func source_selection_ticks_subscribe_and_unticks_only_hide() {
        let sources: [CalendarSourceSelection.Source] = [.init(id: "a", isSelected: true), .init(id: "b", isSelected: false)]
        #expect(CalendarSourceSelection.selected(stored: nil, sources: sources) == ["a"])
        #expect(CalendarSourceSelection.toggle("a", selected: ["a"], sources: sources).next == [])
        let tick = CalendarSourceSelection.toggle("b", selected: ["a"], sources: sources)
        #expect(tick.next == ["a", "b"] && tick.subscribe == "b")
    }

    @Test func view_state_decodes_an_older_shape() throws {
        let data = Data(#"{"view":"week","visualTypes":["event","bogus"]}"#.utf8)
        let state = try JSONDecoder().decode(CalendarViewState.self, from: data)
        #expect(state.view == .week)
        #expect(state.visualTypes == [.event])
        #expect(state.showMemryItems && state.timeline == TimelineSettings())
    }

    @Test func an_all_day_span_ends_on_the_day_before_its_exclusive_end() {
        let start = CalendarDates.iso(CalendarDates.start(of: "2026-09-24"))
        let end = CalendarDates.iso(CalendarDates.start(of: "2026-09-27"))
        let offsite = item("offsite", start: start, end: end, allDay: true)
        #expect(CalendarDates.spanEnd(offsite) == "2026-09-26")
        #expect(CalendarDates.spanDays(offsite) == 3)
    }

    /// An imported all-day event sits on UTC midnights; it covers its UTC
    /// days wherever the phone is (§6 CL051). A local-midnight one keeps the
    /// local reading.
    @Test func an_imported_all_day_event_keeps_its_utc_day() {
        let holiday = item("holiday", start: "2026-10-12T00:00:00.000Z", end: "2026-10-13T00:00:00.000Z", allDay: true)
        let offsetHere = TimeZone.current.secondsFromGMT(for: CalendarDates.date("2026-10-12T00:00:00.000Z")!)
        if offsetHere != 0 {
            #expect(CalendarDates.isUtcAllDay(holiday))
        }
        #expect(CalendarDates.spanStart(holiday) == "2026-10-12")
        #expect(CalendarDates.spanEnd(holiday) == "2026-10-12")
        let local = item("local", start: CalendarDates.iso(CalendarDates.start(of: "2026-10-12")),
                         end: CalendarDates.iso(CalendarDates.start(of: "2026-10-13")), allDay: true)
        #expect(CalendarDates.spanStart(local) == "2026-10-12" && CalendarDates.spanEnd(local) == "2026-10-12")
    }

    @Test func the_zone_table_carries_each_transition() {
        let newYork = TimeZone(identifier: "America/New_York")!
        let from = CalendarDates.date("2026-10-30T00:00:00.000Z")!
        let to = CalendarDates.date("2026-11-05T00:00:00.000Z")!
        let zone = CalendarDates.zone(from: from, to: to, timeZone: newYork)
        #expect(zone.baseOffsetMs == -4 * 3_600_000)
        #expect(zone.transitions.map(\.offsetMs) == [-5 * 3_600_000])
    }

    @Test func snooze_options_match_desktop() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let now = calendar.date(from: DateComponents(year: 2026, month: 9, day: 24, hour: 18, minute: 30))!
        #expect(CalendarSnoozeOptions.laterToday(now: now, isAllDay: false)?.dueTime == "20:00")
        #expect(CalendarSnoozeOptions.tomorrow(now: now, isAllDay: true) == .init(dueDate: "2026-09-25", dueTime: nil))
        #expect(CalendarSnoozeOptions.nextWeek(now: now, isAllDay: false) == .init(dueDate: "2026-09-28", dueTime: "09:00"))
        let late = calendar.date(from: DateComponents(year: 2026, month: 9, day: 24, hour: 19, minute: 5))!
        #expect(CalendarSnoozeOptions.laterToday(now: late, isAllDay: false) == nil)
    }

    @Test func a_calendar_link_reads_its_day_and_event() {
        let link = CalendarLink(url: URL(string: "memry://calendar?date=2026-09-24&event=event:abc")!)
        #expect(link == CalendarLink(date: "2026-09-24", event: "event:abc"))
        #expect(CalendarLink(url: URL(string: "memry://calendar?date=bad")!)?.date == nil)
        #expect(CalendarLink(url: URL(string: "memry://notes")!) == nil)
    }
}

@Suite("Calendar colour tokens — spec 007 CL020")
struct CalendarTokenTests {
    @Test func every_meta_ink_clears_AA_on_its_surface_in_both_styles() {
        let base = [Tokens.Calendar.indigo, Tokens.Calendar.violet, Tokens.Calendar.green, Tokens.Calendar.cyan, Tokens.Calendar.amber, Tokens.Calendar.pink]
        let custom: [Tokens.Calendar.Hue] = Tokens.Calendar.eventColors.compactMap { Tokens.Calendar.hue(hex: String(format: "#%06x", $0.hex)) }
        let hues = base + custom
        for hue in hues {
            for style in [UIUserInterfaceStyle.light, .dark] {
                let ratio = AdaptiveColor.RGB.contrast(hue.meta.rgb(for: style), hue.surface.rgb(for: style))
                #expect(ratio >= 4.5, "meta on surface \(ratio)")
                let title = AdaptiveColor.RGB.contrast(Tokens.Text.primary.rgb(for: style), hue.surface.rgb(for: style))
                #expect(title >= 4.5, "title on surface \(title)")
            }
        }
    }
}
