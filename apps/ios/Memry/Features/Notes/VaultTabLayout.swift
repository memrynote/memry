import Foundation
import Observation
import SwiftUI

// Which page of the vault shell gets a tab, and which sits behind Menu.
//
// **Compact width: five slots, three of them fixed.** iPhone shows five tabs
// before the system adds its own More, and a search tab counts as one of them.
// Home and Notes are pinned first, Menu is pinned last, so two slots follow the
// user's order and every other shown page goes behind Menu.
//
// **Regular width: every page is a sidebar row** (`DESIGN.md` › Tablet, D1):
// desktop's rail pages in the rail order, then Notes, then Settings last (the
// shell appends Settings in Menu's place). Nothing is behind a menu.
//
// **The order is desktop's.** `sidebar.railOrder` is the desktop rail the user
// drags (home, inbox, journal, calendar, tasks, graph). Notes is not in it:
// desktop shows notes as the sidebar tree, not a rail page, which is why it is
// pinned here. Ids this app has no page for (graph, anything newer) are
// skipped.
//
// **The compact default is mobile's own.** Desktop's default order puts Inbox
// and Journal first, which would hide Tasks behind Menu for everyone who never
// dragged the rail. An empty saved order uses `defaultOrder` instead. The
// sidebar hides nothing, so it keeps desktop's default (`railDefault`).

struct VaultTabLayout: Equatable {
    /// Which mapping the shell shows. The sidebar needs room both ways: an
    /// iPad window narrow enough to be compact, and an iPhone in landscape
    /// (compact height, regular width on the large models), keep the bar.
    enum Width: Equatable {
        case compact, regular

        init(horizontal: UserInterfaceSizeClass?, vertical: UserInterfaceSizeClass?) {
            self = horizontal == .regular && vertical == .regular ? .regular : .compact
        }
    }

    /// Where a regular window puts its pages. Landscape pins the sidebar. A
    /// portrait sidebar is an overlay over the page, and SwiftUI cannot close
    /// it, so a link that routes (`memry://calendar`) would select a page
    /// under it; portrait starts on the tab bar with the sidebar a tap away.
    static func placement(for size: CGSize) -> AdaptableTabBarPlacement {
        size.width > size.height ? .sidebar : .automatic
    }

    static let pinned: [VaultTab] = [.home, .notes]
    static let orderedSlots = 2
    static let defaultOrder: [VaultTab] = [.tasks, .journal, .inbox, .calendar]
    /// Desktop's rail without Graph, which iOS does not have
    /// (`app-sidebar.tsx` `mainNav`).
    static let railDefault: [VaultTab] = [.home, .inbox, .journal, .calendar, .tasks]

    /// The tabs before Menu (compact) or Settings (regular), in order.
    let bar: [VaultTab]
    /// The shown pages behind Menu, in order. Empty at regular width.
    let menu: [VaultTab]

    init(savedOrder: [String], width: Width = .compact, isShown: (VaultTab) -> Bool) {
        switch width {
        case .compact:
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
        case .regular:
            bar = Self.railOrder(savedOrder).filter(isShown) + [.notes]
            menu = []
        }
    }

    /// Desktop's `resolveSidebarSectionOrder` over the rail pages: the saved
    /// ids first, then each missing page right after the nearest default page
    /// before it, so a page an older order lacks lands in its default slot.
    private static func railOrder(_ savedOrder: [String]) -> [VaultTab] {
        var result: [VaultTab] = []
        for id in savedOrder {
            guard let page = VaultTab(rawValue: id), railDefault.contains(page), !result.contains(page) else {
                continue
            }
            result.append(page)
        }
        for (index, page) in railDefault.enumerated() where !result.contains(page) {
            let anchor = railDefault[..<index].reversed().lazy.compactMap { result.firstIndex(of: $0) }.first
            result.insert(page, at: anchor.map { $0 + 1 } ?? 0)
        }
        return result
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
