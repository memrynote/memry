import SwiftUI
import Testing

@testable import Memry

// #4379: the ⌘P palette lists the menu bar's own commands, each once, and
// narrows them as desktop's palette does.

@MainActor
@Suite("Command palette")
struct CommandPaletteTests {
    private let tasks = TasksRouter()
    private let journal = JournalRouter()

    /// Every command runnable: a writer, capture, and a journal day on screen.
    private func commands() -> VaultCommands {
        journal.tabs = tasks
        tasks.selectedTab = .journal
        journal.path = [.day("2099-03-03")]
        var commands = VaultCommands(
            tasks: tasks,
            journal: journal,
            pages: VaultTabLayout(savedOrder: [], width: .regular) { _ in true }.commandPages,
            newNote: {},
            quickCapture: {},
            search: {},
            commandPalette: { _ in }
        )
        commands.journalDay = JournalDayCommands(step: { _ in }, today: {})
        return commands
    }

    @Test func every_menu_bar_command_is_in_the_palette_but_the_palette() {
        let commands = commands()
        let listed = commands.paletteCommands(matching: "")
        #expect(Set(listed) == Set(commands.menuCommands).subtracting([.commandPalette]))
        #expect(listed.count == Set(listed).count)
    }

    @Test func ids_are_unique_and_pages_carry_the_catalogs() {
        let commands = commands()
        let ids = commands.menuCommands.map(commands.id)
        #expect(Set(ids).count == ids.count)
        #expect(commands.id(.page(1)) == "go.home")
        #expect(commands.title(.page(1)) == "Go to Home")
    }

    @Test func a_query_narrows_to_matches_best_first() {
        let commands = commands()
        #expect(commands.paletteCommands(matching: "new note").first == .newNote)
        #expect(!commands.paletteCommands(matching: "new note").contains(.newTask))
        #expect(commands.paletteCommands(matching: "  NEW  ").prefix(2) == [.newNote, .newTask])
        #expect(commands.paletteCommands(matching: "settings") == [.settings], "a word of the title")
        #expect(commands.paletteCommands(matching: "gtinb") == [.page(2)], "letters in order")
        #expect(commands.paletteCommands(matching: "zzz").isEmpty)
    }

    @Test func journal_commands_show_only_on_the_journal_day_and_lead_the_list() {
        let commands = commands()
        #expect(commands.paletteCommands(matching: "").prefix(2) == [.previousDay, .nextDay])

        tasks.selectedTab = .notes
        let elsewhere = commands.paletteCommands(matching: "")
        #expect(!elsewhere.contains(.previousDay) && !elsewhere.contains(.nextDay))
        #expect(elsewhere.contains(.today), "Today is app-wide, as ⌘T")
    }

    @Test func a_command_that_cannot_run_is_not_listed() {
        var commands = commands()
        commands = VaultCommands(
            tasks: tasks, journal: journal, pages: commands.pages,
            newNote: nil, quickCapture: nil, search: {}, commandPalette: { _ in }
        )
        let listed = commands.paletteCommands(matching: "")
        #expect(!listed.contains(.newNote) && !listed.contains(.quickCapture))
    }

    @Test func the_palette_command_opens_the_palette_over_its_commands() {
        var opened: VaultCommands?
        let commands = VaultCommands(
            tasks: tasks, journal: journal, pages: [.home],
            newNote: nil, quickCapture: nil, search: {}, commandPalette: { opened = $0 }
        )
        commands.run(.commandPalette)
        #expect(opened?.pages == [.home])
    }

    @Test func shortcut_symbols_read_as_the_menu_shows_them() {
        #expect(AppCommand.quickCapture.shortcut.symbols == "⇧⌘N")
        #expect(AppCommand.nextDay.shortcut.symbols == "⌥⌘→")
        #expect(AppCommand.commandPalette.shortcut.symbols == "⌘P")
    }
}
