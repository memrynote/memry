import SwiftUI
import UIKit

// #4355. The app's keyboard commands: iPadOS lists them in the menu bar and in
// the hold-⌘ overlay, and a hardware keyboard fires them on iPhone too. This
// table is the one place an app-wide key is bound (`DESIGN.md` › Tablet ›
// Pointer and keyboard). Keys start from desktop's defaults in
// `packages/contracts/src/commands/`; iPad additions and substitutes for keys
// iPadOS reserves follow epic #4334's keyboard decisions.
//
// A command fires only while nothing is presented over the window: a sheet,
// the search palette, an alert or a menu. Changing the page or opening another
// sheet under one leaves SwiftUI with a presentation it drops, such as a
// search that will not open again (REVIEW-4523).
//
// Synced user overrides (`shortcut-bindings`) are follow-up #4383 (Q9).

enum AppCommand: Hashable {
    case newNote, quickCapture, newTask, search, settings, today, previousDay, nextDay
    /// The `n`th page in the visible order, 1–9.
    case page(Int)

    static let pageNumbers = 1 ... 9

    var shortcut: KeyboardShortcut {
        switch self {
        // nav.newNote, nav.search, nav.settings
        case .newNote: KeyboardShortcut("n", modifiers: .command)
        case .search: KeyboardShortcut("k", modifiers: .command)
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

    var title: String {
        switch self {
        case .newNote: NotesCreateCopy.newNote
        case .quickCapture: QuickCaptureCopy.commandTitle
        case .newTask: TasksCopy.addTask
        case .search: GlobalSearchCopy.open
        case .settings: SettingsCopy.title
        case .today: JournalCopy.goToToday
        case .previousDay: JournalCopy.previousDay
        case .nextDay: JournalCopy.nextDay
        case let .page(number): "Page \(number)"
        }
    }

    /// Every command with a fixed title, in menu order.
    static let fixed: [AppCommand] = [.newNote, .quickCapture, .newTask, .search, .settings, .today, .previousDay, .nextDay]
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
            button(.newNote)
            button(.quickCapture)
            button(.newTask)
        }
        CommandGroup(replacing: .appSettings) {
            button(.settings)
        }
        CommandMenu("Go") {
            button(.search)
            Divider()
            button(.today)
            button(.previousDay)
            button(.nextDay)
            if let target {
                Divider()
                ForEach(Array(target.pages.prefix(AppCommand.pageNumbers.count).enumerated()), id: \.element) { index, page in
                    button(.page(index + 1), title: page.title)
                }
            }
        }
    }

    private func button(_ command: AppCommand, title: String? = nil) -> some View {
        Button(title ?? command.title) {
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
            .contains { $0.isKeyWindow && $0.rootViewController.map(presents) == true }
    }

    @MainActor
    private static func presents(_ controller: UIViewController) -> Bool {
        controller.presentedViewController != nil || controller.children.contains(where: presents)
    }
}
