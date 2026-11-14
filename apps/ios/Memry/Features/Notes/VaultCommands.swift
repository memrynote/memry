import SwiftUI

// #4355. What the app's keyboard commands (`MemryCommands`) do in an open
// vault. The shell publishes one of these as a focused scene value; each
// command calls the open or create its page's own control already uses, so
// nothing here re-implements an action. The menu bar and the ⌘P palette
// (#4379) both run commands through `can` and `run` here.

@MainActor
struct VaultCommands {
    let tasks: TasksRouter
    let journal: JournalRouter
    /// ⌘1–⌘9, in the order the sidebar (or the tab bar, then Menu) shows.
    let pages: [VaultTab]
    /// `nil` when this device has no identity to write a note under.
    let newNote: (() -> Void)?
    /// `nil` when the vault has no capture writers.
    let quickCapture: (() -> Void)?
    let search: () -> Void
    /// ⇧⌘B toggles the Day Panel where a rail fits.
    let sideRails: SideRails
    /// Opens the ⌘P palette over these commands, with the journal day they
    /// carry at the moment ⌘P was pressed.
    let commandPalette: (VaultCommands) -> Void
    /// The shown journal day's own keys, when a day page is on screen.
    var journalDay: JournalDayCommands?

    /// Today's date in the Journal's terms, as the router and capture use it.
    var today: () -> String = { JournalClock.debugPin() ?? JournalDates.key(Date()) }

    /// The page ⌘`number` opens, if that many pages show.
    func page(_ number: Int) -> VaultTab? {
        pages.indices.contains(number - 1) ? pages[number - 1] : nil
    }

    /// ⌘1–⌘9 for the pages that show.
    var pageCommands: [AppCommand] {
        AppCommand.pageNumbers.prefix(pages.count).map(AppCommand.page)
    }

    /// What the menu bar lists, in its order.
    var menuCommands: [AppCommand] { AppCommand.fixed + pageCommands }

    /// A page command's catalog id, `go.<page>`, or the command's own.
    func id(_ command: AppCommand) -> String {
        if case let .page(number) = command, let page = page(number) { return "go.\(page.rawValue)" }
        return command.id
    }

    /// A page command's menu name, the page's own, or the command's.
    func title(_ command: AppCommand) -> String {
        if case let .page(number) = command, let page = page(number) { return page.title }
        return command.title
    }

    /// A page command's catalog name, "Go to <page>", or the command's own.
    func paletteTitle(_ command: AppCommand) -> String {
        if case let .page(number) = command, let page = page(number) { return CommandCopy.goTo(page.title) }
        return command.paletteTitle
    }

    /// The palette's rows for `query`: every menu command that can run now
    /// except the palette itself, best match first (`CommandMatch`).
    /// Commands of the shown page's context sort above an equal match.
    func paletteCommands(matching query: String) -> [AppCommand] {
        let needle = CommandMatch.normalized(query)
        return menuCommands.enumerated()
            .filter { $0.element != .commandPalette && can($0.element) }
            .map { index, command in
                let score = needle.isEmpty ? 1 : CommandMatch.score(paletteTitle(command), needle)
                return (command, score, command.context == .app ? 0 : 1, -index)
            }
            .filter { $0.1 > 0 }
            .sorted { ($0.1, $0.2, $0.3) > ($1.1, $1.2, $1.3) }
            .map(\.0)
    }

    /// The day page is on top: not covered by a note or Settings it pushed.
    private var dayShown: JournalDayCommands? {
        tasks.selectedTab == .journal && journal.shownDay != nil ? journalDay : nil
    }

    func can(_ command: AppCommand) -> Bool {
        switch command {
        case .newNote: newNote != nil
        case .quickCapture: quickCapture != nil
        case .newTask: VaultTab.tasks.isShown
        case .search, .commandPalette, .settings: true
        case .today: VaultTab.journal.isShown
        case .previousDay, .nextDay: dayShown != nil
        case .dayPanel: sideRails.room != .none
        case let .page(number): page(number) != nil
        }
    }

    func run(_ command: AppCommand) {
        guard can(command) else { return }
        switch command {
        case .newNote: newNote?()
        case .quickCapture: quickCapture?()
        case .newTask: tasks.newTask()
        case .search: search()
        case .commandPalette: commandPalette(self)
        case .settings: tasks.openSettings(.root)
        case .today:
            // On the day page, Today replaces the shown day in place.
            if let dayShown { dayShown.today() } else { journal.openDay(today()) }
        case .previousDay: dayShown?.step(-1)
        case .nextDay: dayShown?.step(1)
        case .dayPanel: sideRails.toggleDayPanel()
        case let .page(number): if let page = page(number) { tasks.selectedTab = page }
        }
    }
}

/// The shown journal day's paging, published by its page.
struct JournalDayCommands {
    let step: (Int) -> Void
    let today: () -> Void
}

extension FocusedValues {
    @Entry var vaultCommands: VaultCommands?
    @Entry var journalDayCommands: JournalDayCommands?
}

extension VaultTabLayout {
    /// The visible order ⌘1–⌘9 follow: the bar, then the pages behind Menu.
    /// Settings has ⌘, of its own.
    var commandPages: [VaultTab] { bar + menu }
}
