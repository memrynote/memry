import Foundation
import Observation

// Which page of the vault shell gets a tab and which sits behind Menu.
//
// **Five slots, three of them fixed.** iPhone shows five tabs before the
// system adds its own More, and a search tab counts as one of them. Home and
// Notes are pinned first, Menu is pinned last, so two slots follow the user's
// order and every other shown page goes behind Menu.
//
// **The order is desktop's.** `sidebar.railOrder` is the desktop rail the user
// drags (home, inbox, journal, calendar, tasks, graph). Notes is not in it:
// desktop shows notes as the sidebar tree, not a rail page, which is why it is
// pinned here. Ids this phone has no page for (home, graph, anything newer)
// are skipped.
//
// **The default is mobile's own.** Desktop's default order puts Inbox and
// Journal first, which would hide Tasks behind Menu for everyone who never
// dragged the rail. An empty saved order uses `defaultOrder` instead.

struct VaultTabLayout: Equatable {
    static let pinned: [VaultTab] = [.home, .notes]
    static let orderedSlots = 2
    static let defaultOrder: [VaultTab] = [.tasks, .journal, .inbox, .calendar]

    /// The tabs before Menu, in order.
    let bar: [VaultTab]
    /// The shown pages behind Menu, in order.
    let menu: [VaultTab]

    init(savedOrder: [String], isShown: (VaultTab) -> Bool) {
        var ordered: [VaultTab] = []
        for id in savedOrder {
            guard let page = VaultTab(rawValue: id), Self.defaultOrder.contains(page), !ordered.contains(page) else { continue }
            ordered.append(page)
        }
        // A page the saved order misses (written before the page existed)
        // keeps its default rank after the ones the user placed.
        ordered += Self.defaultOrder.filter { !ordered.contains($0) }
        let shown = ordered.filter(isShown)
        bar = Self.pinned + shown.prefix(Self.orderedSlots)
        menu = Array(shown.dropFirst(Self.orderedSlots))
    }

    /// The tab the bar highlights for a page: its own, or Menu for a page
    /// behind it, for Settings, and for a page no longer shown.
    func barSelection(for page: VaultTab) -> VaultTab {
        bar.contains(page) ? page : .more
    }

    /// What the Menu tab shows: the selected page when it lives behind Menu,
    /// otherwise Settings.
    func menuContent(for page: VaultTab) -> VaultTab {
        menu.contains(page) ? page : .more
    }
}

extension VaultTab {
    var title: String {
        switch self {
        case .home: "Home"
        case .notes: "Notes"
        case .inbox: InboxCopy.title
        case .tasks: "Tasks"
        case .journal: "Journal"
        case .calendar: CalendarCopy.title
        case .more: "Menu"
        }
    }

    var symbol: String {
        switch self {
        case .home: "house"
        case .notes: "doc.text"
        case .inbox: "tray"
        case .tasks: "checkmark.circle"
        case .journal: "book"
        case .calendar: "calendar"
        case .more: "line.3.horizontal"
        }
    }
}

/// The desktop rail order this phone last read, kept across launches so the
/// bar does not rearrange itself while the synced settings load.
@MainActor
@Observable
final class VaultTabOrder {
    static let shared = VaultTabOrder()
    private static let key = "shell.railOrder"

    private let defaults: UserDefaults
    private(set) var saved: [String]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        saved = defaults.stringArray(forKey: Self.key) ?? []
    }

    func update(_ order: [String]) {
        guard order != saved else { return }
        saved = order
        defaults.set(order, forKey: Self.key)
    }
}
