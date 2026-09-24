import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// TP053: task reminders over the real core, the notification window
// (FR-062), the tap route (FR-061) and the desktop presets.

/// A notification center that records instead of scheduling.
final class FakeReminderCenter: ReminderNotificationCenter, @unchecked Sendable {
    private struct State {
        var authorization: ReminderAuthorization
        var grant: Bool
        var requests = 0
        var pending: [String: ReminderNotification] = [:]
        var delivered: Set<String> = []
        var removedDelivered: [String] = []
    }

    private let state: Mutex<State>

    init(authorization: ReminderAuthorization = .allowed, grant: Bool = true) {
        state = Mutex(State(authorization: authorization, grant: grant))
    }

    var pending: [String: ReminderNotification] { state.withLock { $0.pending } }
    var permissionRequests: Int { state.withLock { $0.requests } }
    var removedDelivered: [String] { state.withLock { $0.removedDelivered } }

    func preload(_ identifier: String, _ notification: ReminderNotification) {
        state.withLock { $0.pending[identifier] = notification }
    }

    func authorization() async -> ReminderAuthorization { state.withLock { $0.authorization } }

    func requestAuthorization() async -> Bool {
        state.withLock {
            $0.requests += 1
            $0.authorization = $0.grant ? .allowed : .denied
            return $0.grant
        }
    }

    func pendingIdentifiers() async -> [String] { state.withLock { Array($0.pending.keys) } }

    func add(_ notifications: [ReminderNotification], now: Date) async {
        state.withLock { state in
            for notification in notifications { state.pending[notification.identifier] = notification }
        }
    }

    func removePending(_ identifiers: [String]) {
        state.withLock { state in
            for identifier in identifiers { state.pending[identifier] = nil }
        }
    }

    func removeDelivered(_ identifiers: [String]) {
        state.withLock { $0.removedDelivered += identifiers }
    }
}

@MainActor
@Suite("Task reminders", .serialized)
struct TasksRemindersTests {
    /// The core refuses a reminder that is not in the future by its own
    /// clock, so reminder times are relative to the real now.
    private static func future(hours: Double) -> Date { Date().addingTimeInterval(hours * 3600) }

    private func vaultNow() throws -> TasksTestVault {
        let vault = try TasksTestVault()
        vault.store.clock = { Date() }
        return vault
    }

    @Test func adding_reminders_lists_them_earliest_first_and_asks_permission_once() async throws {
        let vault = try vaultNow()
        let task = try vault.task("[agent] remind", project: vault.project())
        let center = FakeReminderCenter(authorization: .notDetermined)
        let scheduler = ReminderScheduler(center: center)

        let store = vault.store
        let later = await store.addReminder(to: task, at: Self.future(hours: 48), note: "later", scheduler: scheduler)
        let sooner = await store.addReminder(to: task, at: Self.future(hours: 2), note: "  ", scheduler: scheduler)

        let reminders = await vault.store.activeReminders(of: task)
        #expect(vault.store.failure == nil)
        #expect(reminders.map(\.id) == [sooner, later].compactMap(\.self))
        #expect(reminders.last?.note == "later")
        #expect(reminders.first?.note == nil)
        #expect(center.permissionRequests == 1)
        #expect(scheduler.authorization == .allowed)
        #expect(center.pending.count == 2)
        #expect(vault.store.toast == TasksCopy.reminderToastSet)
    }

    @Test func a_past_time_is_refused_and_reported() async throws {
        let vault = try vaultNow()
        let task = try vault.task("[agent] past", project: vault.project())
        let scheduler = ReminderScheduler(center: FakeReminderCenter())

        let id = await vault.store.addReminder(to: task, at: Self.future(hours: -1), note: nil, scheduler: scheduler)

        #expect(id == nil)
        #expect(vault.store.failure != nil)
        #expect(await vault.store.activeReminders(of: task).isEmpty)
    }

    @Test func edit_snooze_dismiss_and_delete_go_through_the_core() async throws {
        let vault = try vaultNow()
        let task = try vault.task("[agent] edit", project: vault.project())
        let center = FakeReminderCenter()
        let scheduler = ReminderScheduler(center: center)
        let first = try #require(await vault.store.addReminder(
            to: task, at: Self.future(hours: 3), note: nil, scheduler: scheduler
        ))
        let second = try #require(await vault.store.addReminder(
            to: task, at: Self.future(hours: 4), note: nil, scheduler: scheduler
        ))

        let moved = Self.future(hours: 30)
        #expect(await vault.store.rescheduleReminder(first, to: moved, scheduler: scheduler))
        var reminders = await vault.store.activeReminders(of: task)
        #expect(reminders.map(\.id) == [second, first])
        #expect(reminders.last?.remindAt == TaskDates.iso(moved))

        #expect(await vault.store.snoozeReminder(second, until: Self.future(hours: 50), scheduler: scheduler))
        reminders = await vault.store.activeReminders(of: task)
        #expect(reminders.first { $0.id == second }?.status == "snoozed")

        #expect(await vault.store.dismissReminder(second, scheduler: scheduler))
        #expect(await vault.store.deleteReminder(first, scheduler: scheduler))
        #expect(await vault.store.activeReminders(of: task).isEmpty)
        #expect(center.pending.isEmpty)
        #expect(center.removedDelivered.contains(ReminderNotification.identifierPrefix + first))
        #expect(vault.store.toast == TasksCopy.reminderToastDeleted)
        #expect(vault.store.undoable == nil)
    }

    @Test func the_window_skips_completed_and_deleted_targets() async throws {
        let vault = try vaultNow()
        let project = try vault.project()
        let open = try vault.task("[agent] open", project: project)
        let done = try vault.task("[agent] done", project: project)
        let gone = try vault.task("[agent] gone", project: project)
        let center = FakeReminderCenter()
        let scheduler = ReminderScheduler(center: center)
        for task in [open, done, gone] {
            await vault.store.addReminder(to: task, at: Self.future(hours: 5), note: nil, scheduler: scheduler)
        }
        let now = vault.store.localNow()
        await vault.store.perform(nil) { try $0.complete(id: done, localNow: now).change }
        await vault.store.perform(nil) { try $0.delete(id: gone, promoteSubtasks: false) }

        await scheduler.refill(from: vault.store)

        #expect(center.pending.values.map(\.targetId) == [open])
        let notification = try #require(center.pending.values.first)
        #expect(notification.title == "[agent] open")
        #expect(notification.body == TasksCopy.reminderNotificationBody(targetType: "task"))
        #expect(notification.userInfo["targetType"] == "task")
        #expect(notification.userInfo["targetId"] == open)
    }

    @Test func refill_replaces_stale_requests_and_leaves_other_apps_ids() async throws {
        let vault = try vaultNow()
        let task = try vault.task("[agent] refill", project: vault.project())
        let center = FakeReminderCenter()
        let stale = ReminderNotification(
            reminderId: "rem_gone", targetType: "task", targetId: "x",
            title: "t", body: "b", fireAt: Self.future(hours: 1)
        )
        center.preload(stale.identifier, stale)
        center.preload("someone.else", stale)
        let scheduler = ReminderScheduler(center: center)

        let id = try #require(await vault.store.addReminder(
            to: task, at: Self.future(hours: 6), note: nil, scheduler: scheduler
        ))

        #expect(Set(center.pending.keys) == [ReminderNotification.identifierPrefix + id, "someone.else"])
    }

    @Test func denied_permission_schedules_nothing() async throws {
        let vault = try vaultNow()
        let task = try vault.task("[agent] denied", project: vault.project())
        let center = FakeReminderCenter(authorization: .notDetermined, grant: false)
        let scheduler = ReminderScheduler(center: center)

        await vault.store.addReminder(to: task, at: Self.future(hours: 6), note: nil, scheduler: scheduler)

        #expect(scheduler.authorization == .denied)
        #expect(center.pending.isEmpty)
        #expect(await vault.store.activeReminders(of: task).count == 1)
    }

    @Test func the_plan_keeps_the_nearest_window_and_counts_the_rest() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let nowMs: Int64 = 1_000_000_000
        func due(_ index: Int, offsetMs: Int64, exists: Bool = true, completed: Bool = false) -> DueReminderItem {
            DueReminderItem(
                reminder: ReminderItem(
                    id: "rem_\(index)", targetType: "task", targetId: "t\(index)", remindAt: "",
                    title: nil, note: nil, status: "pending", snoozedUntil: nil
                ),
                fireAt: "", fireAtMs: nowMs + offsetMs, targetTitle: "Task \(index)",
                targetExists: exists, targetCompleted: completed
            )
        }
        var items = (0 ..< 70).map { due($0, offsetMs: Int64($0 + 1) * 60000) }
        items.append(due(70, offsetMs: -60000))
        items.append(due(71, offsetMs: 1000, exists: false))
        items.append(due(72, offsetMs: 1000, completed: true))

        let plan = ReminderSchedulePlan.make(items, now: now)

        #expect(plan.notifications.count == ReminderSchedulePlan.window)
        #expect(plan.notifications.first?.reminderId == "rem_0")
        #expect(plan.notifications.last?.reminderId == "rem_59")
        #expect(plan.beyondWindow == 10)
        #expect(plan.notifications.first?.title == "Task 0")
    }

    @Test func a_tap_opens_its_task_and_other_targets_open_notes() throws {
        let router = TasksRouter()
        let info: [AnyHashable: Any] = ["reminderId": "rem_1", "targetType": "task", "targetId": "task-1"]
        let tap = try #require(ReminderTap(userInfo: info))
        tap.open(in: router)
        #expect(router.selectedTab == .tasks)
        #expect(router.path == [.task("task-1")])

        let noteRouter = TasksRouter()
        noteRouter.selectedTab = .more
        ReminderTap(reminderId: "rem_2", targetType: "note", targetId: "note-1").open(in: noteRouter)
        #expect(noteRouter.selectedTab == .notes)
        #expect(ReminderTap(userInfo: ["aps": "x"]) == nil)

        let taps = ReminderTaps()
        taps.receive(tap)
        #expect(taps.take() == tap)
        #expect(taps.take() == nil)
    }

    @Test func presets_follow_desktops_reminder_presets() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        func local(_ day: Int, _ hour: Int) throws -> Date {
            try #require(calendar.date(from: DateComponents(year: 2026, month: 1, day: day, hour: hour)))
        }
        // Wednesday 2026-01-14.
        #expect(try TaskReminderPresets.laterToday(local(14, 12)) == local(14, 16))
        #expect(try TaskReminderPresets.laterToday(local(14, 18)) == local(14, 20))
        #expect(try TaskReminderPresets.laterToday(local(14, 21)) == local(15, 9))
        #expect(try TaskReminderPresets.nextMonday(hour: 9, from: local(14, 12)) == local(19, 9))
        // Sunday 18th -> Monday 19th; Monday 19th -> Monday 26th.
        #expect(try TaskReminderPresets.nextMonday(hour: 9, from: local(18, 12)) == local(19, 9))
        #expect(try TaskReminderPresets.nextMonday(hour: 9, from: local(19, 12)) == local(26, 9))
        let presets = try TaskReminderPresets.standard(now: local(14, 12))
        #expect(presets.map(\.id) == ["later-today", "tomorrow", "next-week", "in-one-month"])
        #expect(try presets[1].date == local(15, 9))
        #expect(try presets[3].date == calendar.date(from: DateComponents(year: 2026, month: 2, day: 14, hour: 9)))
        #expect(try TaskReminderPresets.snooze(now: local(14, 12)).map(\.id)
            == ["in-15-min", "in-1-hour", "in-3-hours", "tomorrow-morning"])
    }

    @Test func reminder_times_read_as_desktops_labels() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 1, day: 14, hour: 12)))
        let today = try #require(calendar.date(from: DateComponents(year: 2026, month: 1, day: 14, hour: 15)))
        let tomorrow = try #require(calendar.date(from: DateComponents(year: 2026, month: 1, day: 15, hour: 9)))
        #expect(TaskReminderPresets.text(today, now: now).hasPrefix("Today at "))
        #expect(TaskReminderPresets.text(tomorrow, now: now).hasPrefix("Tomorrow at "))
        #expect(TaskReminderPresets.instant("2026-01-14T11:00:00.000Z") != nil)
        #expect(TaskReminderPresets.instant("2026-01-14T11:00:00Z") != nil)
        #expect(TasksCopy.reminderSummary("Today at 3 PM", more: 2) == "Reminder: Today at 3 PM (+2 more)")
    }
}
