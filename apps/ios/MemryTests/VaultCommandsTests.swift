import SwiftUI
import Testing

@testable import Memry

// #4355: each app command lands where the page's own control would, and a
// command with nothing to act on does nothing.

@MainActor
@Suite("Vault keyboard commands")
struct VaultCommandsTests {
    private let tasks = TasksRouter()
    private let journal = JournalRouter()

    private func commands(
        width: LayoutWidth = .regular,
        newNote: (() -> Void)? = nil,
        journalDay: JournalDayCommands? = nil
    ) -> VaultCommands {
        journal.tabs = tasks
        var commands = VaultCommands(
            tasks: tasks,
            journal: journal,
            pages: VaultTabLayout(savedOrder: [], width: width) { _ in true }.commandPages,
            newNote: newNote,
            quickCapture: nil,
            search: {}
        )
        commands.journalDay = journalDay
        commands.today = { "2099-03-04" }
        return commands
    }

    @Test func command_digits_follow_the_sidebar_order() {
        let commands = commands()
        commands.run(.page(2))
        #expect(tasks.selectedTab == .inbox)
        commands.run(.page(6))
        #expect(tasks.selectedTab == .notes)
        #expect(!commands.can(.page(7)), "Settings has ⌘, rather than a digit")
    }

    @Test func compact_digits_count_the_bar_then_the_pages_behind_menu() {
        let commands = commands(width: .compact)
        commands.run(.page(5))
        #expect(tasks.selectedTab == .inbox)
    }

    @Test func settings_opens_the_settings_root() {
        tasks.settingsPath.append(SettingsRoute.account)
        commands().run(.settings)
        #expect(tasks.selectedTab == .more)
        #expect(tasks.settingsPath.isEmpty)
    }

    @Test func new_task_asks_the_task_list_for_its_composer_once() {
        tasks.path = [.projects]
        commands().run(.newTask)
        #expect(tasks.selectedTab == .tasks)
        #expect(tasks.path.isEmpty)
        #expect(tasks.takeComposerRequest())
        #expect(!tasks.takeComposerRequest())
    }

    @Test func new_task_in_the_split_view_keeps_the_open_task() {
        tasks.setTasksSplit(true)
        tasks.path = [.projects, .task("a")]
        commands().run(.newTask)
        #expect(tasks.path == [.task("a")])
        #expect(tasks.takeComposerRequest())
    }

    @Test func an_untaken_new_task_request_drops_when_the_page_changes() {
        commands().run(.newTask)
        tasks.selectedTab = .notes
        tasks.selectedTab = .tasks
        #expect(!tasks.takeComposerRequest(), "a later visit must not open the composer")
    }

    @Test func today_opens_the_journal_day_from_another_page() {
        tasks.selectedTab = .notes
        commands().run(.today)
        #expect(tasks.selectedTab == .journal)
        #expect(journal.shownDay == "2099-03-04")
    }

    @Test func day_keys_page_only_the_journal_day_on_screen() {
        var steps: [Int] = []
        var todays = 0
        let day = JournalDayCommands(step: { steps.append($0) }, today: { todays += 1 })
        tasks.selectedTab = .notes
        let commands = commands(journalDay: day)
        #expect(!commands.can(.previousDay), "a hidden Journal tab's day must not move")
        commands.run(.previousDay)
        #expect(steps.isEmpty)

        tasks.selectedTab = .journal
        journal.path = [.day("2099-03-03")]
        commands.run(.previousDay)
        commands.run(.nextDay)
        commands.run(.today)
        #expect(steps == [-1, 1])
        #expect(todays == 1, "Today on the day page replaces the day in place")
    }

    @Test func day_keys_leave_a_note_pushed_over_the_day_alone() {
        var steps: [Int] = []
        var todays = 0
        let day = JournalDayCommands(step: { steps.append($0) }, today: { todays += 1 })
        tasks.selectedTab = .journal
        journal.path = [.day("2099-03-03"), .note("n1")]
        let commands = commands(journalDay: day)
        #expect(!commands.can(.previousDay), "the day under a note must not move")
        commands.run(.previousDay)
        commands.run(.nextDay)
        #expect(steps.isEmpty)
        #expect(todays == 0)
    }

    @Test func new_note_without_a_writer_does_nothing() {
        tasks.selectedTab = .tasks
        let commands = commands(newNote: nil)
        #expect(!commands.can(.newNote))
        commands.run(.newNote)
        #expect(tasks.selectedTab == .tasks)
    }

    @Test func every_command_has_its_own_key() {
        let all = AppCommand.fixed + AppCommand.pageNumbers.map(AppCommand.page)
        #expect(Set(all.map(\.shortcut)).count == all.count)
    }
}
