import SwiftUI

// #4355. What the app's keyboard commands (`MemryCommands`) do in an open
// vault. The shell publishes one of these as a focused scene value; each
// command calls the open or create its page's own control already uses, so
// nothing here re-implements an action.

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
    /// The shown journal day's own keys, when a day page is on screen.
    var journalDay: JournalDayCommands?

    /// Today's date in the Journal's terms, as the router and capture use it.
    var today: () -> String = { JournalClock.debugPin() ?? JournalDates.key(Date()) }

    /// The page ⌘`number` opens, if that many pages show.
    func page(_ number: Int) -> VaultTab? {
        pages.indices.contains(number - 1) ? pages[number - 1] : nil
    }

    private var dayShown: JournalDayCommands? {
        tasks.selectedTab == .journal ? journalDay : nil
    }

    func can(_ command: AppCommand) -> Bool {
        switch command {
        case .newNote: newNote != nil
        case .quickCapture: quickCapture != nil
        case .newTask: VaultTab.tasks.isShown
        case .search, .settings: true
        case .today: VaultTab.journal.isShown
        case .previousDay, .nextDay: dayShown != nil
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
        case .settings: tasks.openSettings(.root)
        case .today:
            // On the day page, Today replaces the shown day in place.
            if let dayShown { dayShown.today() } else { journal.openDay(today()) }
        case .previousDay: dayShown?.step(-1)
        case .nextDay: dayShown?.step(1)
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
