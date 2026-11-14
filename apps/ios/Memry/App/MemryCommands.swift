import SwiftUI
import UIKit

// #4355. The app's keyboard commands: iPadOS lists them in the menu bar and in
// the hold-⌘ overlay, and a hardware keyboard fires them on iPhone too. This
// table is the one place an app-wide key is bound (`DESIGN.md` › Tablet ›
// Pointer and keyboard). Keys start from desktop's defaults in
// `packages/contracts/src/commands/`; iPad additions and substitutes for keys
// iPadOS reserves follow epic #4334's keyboard decisions.
//
// **One registry (#4379).** A command's id, titles and key live here, and its
// `can` and `run` on `VaultCommands`. It has two titles: the menu bar's short
// iOS name (`title`) and the catalog's name the palette shows (`paletteTitle`). The menu bar and the ⌘P palette
// (`CommandPalette`) both list these, so a command is defined once.
//
// A command fires only while nothing is presented over the window: a sheet,
// the search palette, an alert or a menu. Changing the page or opening another
// sheet under one leaves SwiftUI with a presentation it drops, such as a
// search that will not open again (REVIEW-4523).
//
// Synced user overrides (`shortcut-bindings`) are follow-up #4383 (Q9).

enum AppCommand: Hashable {
    case newNote, quickCapture, newTask, search, commandPalette, settings, today, previousDay, nextDay
    /// The `n`th page in the visible order, 1–9.
    case page(Int)

    static let pageNumbers = 1 ... 9

    /// The catalog's id (`packages/contracts/src/commands/`). A page's is
    /// `VaultCommands.id(_:)`, which knows the page.
    var id: String {
        switch self {
        case .newNote: "nav.newNote"
        case .search: "nav.search"
        case .commandPalette: "nav.commands"
        case .settings: "nav.settings"
        case .newTask: "create.task"
        case .today: "journal.today"
        case .previousDay: "journal.previous"
        case .nextDay: "journal.next"
        // An iPad addition with no catalog entry yet (desktop #4384).
        case .quickCapture: "capture.quick"
        case let .page(number): "page.\(number)"
        }
    }

    /// Where it acts, as the catalog's `context`: the palette lists a command
    /// of the shown page's context first.
    var context: CommandContext {
        switch self {
        case .previousDay, .nextDay: .journal
        default: .app
        }
    }

    var shortcut: KeyboardShortcut {
        switch self {
        // nav.newNote, nav.search, nav.commands, nav.settings
        case .newNote: KeyboardShortcut("n", modifiers: .command)
        case .search: KeyboardShortcut("k", modifiers: .command)
        case .commandPalette: KeyboardShortcut("p", modifiers: .command)
        case .settings: KeyboardShortcut(",", modifiers: .command)
        // iPad additions (epic #4334); desktop follow-up #4384.
        case .quickCapture: KeyboardShortcut("n", modifiers: [.shift, .command])
        case .newTask: KeyboardShortcut("n", modifiers: [.option, .command])
        case .today: KeyboardShortcut("t", modifiers: .command)
        // Desktop pages days with bare ← →, which a text view needs for its
        // caret; the journal page keeps those itself (`JournalDayShortcuts`).
        case .previousDay: KeyboardShortcut(.leftArrow, modifiers: [.option, .command])
        case .nextDay: KeyboardShortcut(.rightArrow, modifiers: [.option, .command])
        // app-sidebar.tsx: ⌘1–⌘9 open the nth visible page.
        case let .page(number): KeyboardShortcut(KeyEquivalent(Character(String(number))), modifiers: .command)
        }
    }

    /// The menu bar's short name. A page's is `VaultCommands.title(_:)`.
    var title: String {
        switch self {
        case .settings: CommandCopy.Menu.settings
        case .today: CommandCopy.Menu.today
        case .previousDay: CommandCopy.Menu.previousDay
        case .nextDay: CommandCopy.Menu.nextDay
        default: paletteTitle
        }
    }

    /// The catalog's name, which the palette shows and matches. A page's is
    /// `VaultCommands.paletteTitle(_:)`.
    var paletteTitle: String {
        switch self {
        case .newNote: CommandCopy.newNote
        case .quickCapture: QuickCaptureCopy.commandTitle
        case .newTask: CommandCopy.newTask
        case .search: CommandCopy.search
        case .commandPalette: CommandCopy.commandPalette
        case .settings: CommandCopy.settings
        case .today: CommandCopy.today
        case .previousDay: CommandCopy.previousDay
        case .nextDay: CommandCopy.nextDay
        case let .page(number): "Page \(number)"
        }
    }

    /// The menu bar's groups, in menu order.
    static let newItem: [AppCommand] = [.newNote, .quickCapture, .newTask]
    static let find: [AppCommand] = [.search, .commandPalette]
    static let journal: [AppCommand] = [.today, .previousDay, .nextDay]

    /// Every command with a fixed title, in menu order.
    static let fixed: [AppCommand] = newItem + [.settings] + find + journal
}

/// The catalog's `context`, for the contexts iOS has commands in.
enum CommandContext {
    case app, journal
}

/// The catalog's English names: `menu.json` › `commands`, and
/// `settings.json` › `shortcuts.entries` for a command with a key
/// (`packages/i18n/src/locales/en/`). iOS has no string catalog.
enum CommandCopy {
    static let newNote = "New Note"
    static let newTask = "New Task"
    static let search = "Search"
    static let commandPalette = "Command Palette"
    static let settings = "Open Settings"
    static let today = "Go to Today's Journal"
    static let previousDay = "Previous Journal Period"
    static let nextDay = "Next Journal Period"
    /// `go.*`: "Go to Home", "Go to Inbox", …
    static func goTo(_ page: String) -> String { "Go to \(page)" }

    /// The menu bar's short iOS names where they differ from the catalog's.
    /// A page's is the page's own title.
    enum Menu {
        static let settings = "Settings…"
        static let today = "Today"
        static let previousDay = "Previous Day"
        static let nextDay = "Next Day"
    }

    // common.json › commandsPalette
    static let paletteTitle = "Commands"
    static let prompt = "Type a command…"
    static let thisJournal = "This journal"
    static func empty(_ query: String) -> String { "No commands match “\(query)”" }
}

struct MemryCommands: Commands {
    @FocusedValue(\.vaultCommands) private var vault
    @FocusedValue(\.journalDayCommands) private var journalDay

    private var target: VaultCommands? {
        guard var vault else { return nil }
        vault.journalDay = journalDay
        return vault
    }

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            ForEach(AppCommand.newItem, id: \.self, content: button)
        }
        CommandGroup(replacing: .appSettings) {
            button(.settings)
        }
        CommandMenu("Go") {
            ForEach(AppCommand.find, id: \.self, content: button)
            Divider()
            ForEach(AppCommand.journal, id: \.self, content: button)
            if let target {
                Divider()
                ForEach(target.pageCommands, id: \.self, content: button)
            }
        }
    }

    private func button(_ command: AppCommand) -> some View {
        Button(target?.title(command) ?? command.title) {
            guard !Self.isPresenting else { return }
            target?.run(command)
        }
        .keyboardShortcut(command.shortcut)
        .disabled(target?.can(command) != true)
    }

    /// Whether anything is presented over the key window.
    @MainActor
    static var isPresenting: Bool {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .contains { $0.isKeyWindow && PresentingWindow.isPresenting(over: $0) }
    }
}
