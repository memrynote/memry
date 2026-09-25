import Foundation
import MemryCore
import Testing

@testable import Memry

// JP046: journal reminders. Desktop's preset date math (JS `Date` month
// overflow, not Foundation clamping), set-or-replace through the store (D8),
// and the notification text (date only, never the note).

@Suite("Journal reminder presets")
struct JournalReminderPresetsTests {
    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .gmt
        return calendar
    }()

    private static func at(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 14, _ minute: Int = 30) -> Date {
        let parts = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)
        return calendar.date(from: parts) ?? .distantPast
    }

    private static func parts(_ date: Date) -> [Int] {
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].map { $0 ?? -1 }
    }

    @Test func the_four_presets_are_desktops_at_nine_local() {
        let presets = JournalReminderPresets.all(now: Self.at(2026, 9, 24), calendar: Self.calendar)
        #expect(presets.map(\.id) == ["in-one-week", "in-one-month", "in-three-months", "in-one-year"])
        #expect(presets.map(\.label) == [
            JournalCopy.presetInOneWeek, JournalCopy.presetInOneMonth,
            JournalCopy.presetInThreeMonths, JournalCopy.presetInOneYear
        ])
        #expect(presets.map { Self.parts($0.date) } == [
            [2026, 10, 1, 9, 0, 0],
            [2026, 10, 24, 9, 0, 0],
            [2026, 12, 24, 9, 0, 0],
            [2027, 9, 24, 9, 0, 0]
        ])
    }

    @Test func month_end_overflows_as_js_setMonth_does() {
        func months(_ count: Int, _ now: Date) -> [Int] {
            Self.parts(JournalReminderPresets.inMonths(count, from: now, calendar: Self.calendar))
        }
        // Jan 31 + 1 month is "Feb 31", which JS rolls to Mar 3 (Mar 2 in a leap year).
        #expect(months(1, Self.at(2026, 1, 31)) == [2026, 3, 3, 9, 0, 0])
        #expect(months(1, Self.at(2024, 1, 31)) == [2024, 3, 2, 9, 0, 0])
        #expect(months(1, Self.at(2026, 8, 31)) == [2026, 10, 1, 9, 0, 0])
        // Nov 30 + 3 months crosses the year into "Feb 30" = Mar 2.
        #expect(months(3, Self.at(2026, 11, 30)) == [2027, 3, 2, 9, 0, 0])
        // Feb 29 + 12 months is "Feb 29, 2025" = Mar 1.
        #expect(months(12, Self.at(2024, 2, 29)) == [2025, 3, 1, 9, 0, 0])
        #expect(months(12, Self.at(2026, 1, 31)) == [2027, 1, 31, 9, 0, 0])
    }

    @Test func a_week_crosses_the_month_and_the_year() {
        let week = JournalReminderPresets.inDays(7, from: Self.at(2026, 12, 28, 23, 59), calendar: Self.calendar)
        #expect(Self.parts(week) == [2027, 1, 4, 9, 0, 0])
        // Across the US spring-forward change, still 09:00 wall clock.
        let spring = JournalReminderPresets.inDays(7, from: Self.at(2026, 3, 5), calendar: Self.calendar)
        #expect(Self.parts(spring) == [2026, 3, 12, 9, 0, 0])
    }

    @Test func the_menu_text_names_the_year_only_when_it_differs() {
        let now = Self.at(2026, 9, 24)
        let locale = Locale(identifier: "en_US")
        let thisYear = JournalReminderPresets.text(
            Self.at(2026, 10, 1, 9, 0), now: now, locale: locale, calendar: Self.calendar
        )
        let nextYear = JournalReminderPresets.text(
            Self.at(2027, 9, 24, 9, 0), now: now, locale: locale, calendar: Self.calendar
        )
        #expect(thisYear.hasPrefix("Thu, Oct 1 · "))
        #expect(!thisYear.contains("2026"))
        #expect(nextYear.hasPrefix("Fri, Sep 24, 2027 · "))
    }
}

@MainActor
@Suite("Journal reminders", .serialized)
struct JournalRemindersTests {
    /// The core refuses a reminder that is not in the future by its own
    /// clock, so times are relative to the real now.
    private static func future(hours: Double) -> Date { Date().addingTimeInterval(hours * 3600) }

    @Test func setting_twice_moves_the_one_reminder_and_never_creates_the_day() async throws {
        let vault = try JournalTestVault()
        let store = vault.store
        let date = JournalTestVault.today
        let center = FakeReminderCenter(authorization: .notDetermined)
        let scheduler = ReminderScheduler(center: center)

        let first = await store.setReminder(
            on: date, at: Self.future(hours: 48), note: "Did the trial month work?", tasks: nil, scheduler: scheduler
        )
        #expect(store.failure == nil)
        #expect(store.toast == JournalCopy.reminderSet)
        #expect(center.permissionRequests == 1)
        #expect(store.activeReminders(date).map(\.note) == ["Did the trial month work?"])

        let later = Self.future(hours: 72)
        let second = await store.setReminder(on: date, at: later, note: "  ", tasks: nil, scheduler: scheduler)

        #expect(first != nil)
        #expect(second == first, "set-or-replace moves the active reminder")
        let active = store.activeReminders(date)
        #expect(active.count == 1)
        #expect(active.first?.remindAt == TaskDates.iso(later))
        #expect(active.first?.note == nil, "an empty note clears the replaced one")
        #expect(active.first?.date == date)
        #expect(store.toast == JournalCopy.reminderUpdated)
        #expect(center.permissionRequests == 1)
        #expect(try vault.journal.entryId(date: date) == nil, "a reminder never creates the day")
    }

    @Test func edit_snooze_and_dismiss_go_through_the_core() async throws {
        let vault = try JournalTestVault()
        let store = vault.store
        let date = JournalTestVault.today
        let scheduler = ReminderScheduler(center: FakeReminderCenter())
        _ = await store.setReminder(on: date, at: Self.future(hours: 5), note: nil, tasks: nil, scheduler: scheduler)
        var reminder = try #require(store.activeReminders(date).first)

        let moved = Self.future(hours: 30)
        #expect(await store.updateReminder(reminder, at: moved, note: "why", tasks: nil, scheduler: scheduler))
        reminder = try #require(store.activeReminders(date).first)
        #expect(reminder.remindAt == TaskDates.iso(moved))
        #expect(reminder.note == "why")

        #expect(await store.snoozeReminder(reminder, until: Self.future(hours: 40), tasks: nil, scheduler: scheduler))
        #expect(store.activeReminders(date).first?.status == "snoozed")
        #expect(store.toast == JournalCopy.reminderSnoozed)

        #expect(await store.dismissReminder(reminder, tasks: nil, scheduler: scheduler))
        #expect(store.activeReminders(date).isEmpty)
        #expect(store.reminders[date]?.count == 1, "dismissed stays listed, inactive")
        #expect(store.toast == JournalCopy.reminderDismissed)

        #expect(await store.deleteReminder(reminder, tasks: nil, scheduler: scheduler))
        #expect(store.reminders[date]?.isEmpty == true)
    }

    @Test func a_past_time_is_refused_and_reported() async throws {
        let vault = try JournalTestVault()
        let scheduler = ReminderScheduler(center: FakeReminderCenter())
        let id = await vault.store.setReminder(
            on: JournalTestVault.today, at: Self.future(hours: -1), note: nil, tasks: nil, scheduler: scheduler
        )
        #expect(id == nil)
        #expect(vault.store.failure != nil)
    }

    @Test func a_journal_notification_shows_the_date_only() throws {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let item = DueReminderItem(
            reminder: ReminderItem(
                id: "rem_j", targetType: "journal", targetId: "2026-09-24", remindAt: "",
                title: nil, note: "private thought", status: "pending", snoozedUntil: nil
            ),
            fireAt: "", fireAtMs: 1_000_060_000, targetTitle: "2026-09-24",
            targetExists: true, targetCompleted: false
        )

        let notification = try #require(ReminderSchedulePlan.make([item], now: now).notifications.first)

        #expect(notification.title == "Journal reminder")
        #expect(notification.body == "Revisit Thursday, September 24")
        #expect(notification.targetId == "2026-09-24")
        #expect(JournalCopy.notificationLongDate("2026-02-30") == nil)
    }
}
