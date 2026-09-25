import Foundation
import Testing

@testable import Memry

// JP031: one route opens a day from anywhere (D11), a journal reminder tap
// opens its day (D8), and the stack survives relaunch.

@MainActor
@Suite("Journal routing")
struct JournalRoutingTests {
    @Test func opening_a_day_selects_the_tab_and_stacks_month_then_day() {
        let tabs = TasksRouter()
        let router = JournalRouter(today: "2099-06-15", tabs: tabs)
        router.openDay("2099-03-02")
        #expect(tabs.selectedTab == .journal)
        #expect(router.rootYear == 2099)
        #expect(router.path == [.month(year: 2099, month: 3), .day("2099-03-02")])
        #expect(router.shownDay == "2099-03-02")
    }

    @Test func a_date_that_is_not_a_day_goes_nowhere() {
        let tabs = TasksRouter()
        let router = JournalRouter(today: "2099-06-15", tabs: tabs)
        router.openDay("2099-02-30")
        #expect(tabs.selectedTab == .notes)
        #expect(router.path.isEmpty)
    }

    @Test func paging_keeps_the_tab_and_drilling_up_climbs_one_level() {
        let tabs = TasksRouter()
        let router = JournalRouter(today: "2099-06-15", tabs: tabs)
        router.showDay("2099-06-15")
        #expect(tabs.selectedTab == .notes, "showing a day does not switch tabs")
        router.drillUp()
        #expect(router.path == [.month(year: 2099, month: 6)])
        router.drillUp()
        #expect(router.path.isEmpty)
    }

    @Test func a_journal_reminder_tap_opens_its_day_and_a_task_tap_its_task() {
        let tabs = TasksRouter()
        let router = JournalRouter(today: "2099-06-15", tabs: tabs)
        ReminderTap(reminderId: "rem_1", targetType: "journal", targetId: "2099-06-01")
            .open(in: tabs, journal: router)
        #expect(tabs.selectedTab == .journal)
        #expect(router.shownDay == "2099-06-01")
        ReminderTap(reminderId: "rem_2", targetType: "task", targetId: "task-1")
            .open(in: tabs, journal: router)
        #expect(tabs.selectedTab == .tasks)
        #expect(tabs.path == [.task("task-1")])
    }

    @Test func the_stack_round_trips_through_its_saved_form() {
        let router = JournalRouter(today: "2099-06-15")
        router.showDay("2099-06-14")
        let saved = router.saved
        let restored = JournalRouter(today: "2000-01-01")
        #expect(restored.restore(saved))
        #expect(restored.path == router.path)
        #expect(restored.rootYear == 2099)
        #expect(!JournalRouter().restore(""))
    }
}
