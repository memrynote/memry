import Observation
import SwiftUI

// #4380. The side rails at regular width (`DESIGN.md` › Tablet › Side rails):
// the Day Panel beside every page, and the note inspector beside a note
// (#4347). One owner measures the page and says which rails fit, so the two
// never disagree about the room.
//
// **Room.** A rail shows only where the page keeps the `720pt` reading
// measure beside it (`1040pt`), and two rails need `1360pt`. The Journal
// keeps its day rail's shipped rule: the panel shows there at any regular
// width. Compact width and accessibility text sizes, which break words in
// the rail's `320pt`, hold none. Each page measures its own room, so a page
// never reads another's.
//
// **Where it shows.** Not on Calendar, whose regular width has its own
// agenda column, and nowhere while Journal is off in Settings › Features.
//
// **One at a time where two do not fit.** Opening one rail closes the other.
// When both are left open (a window that shrank), the Day Panel shows and the
// inspector waits; its button stays, and tapping it shows it and closes the
// panel.
//
// **Per device.** The open states live in `UserDefaults`, never in the vault
// and never synced. The Day Panel keeps one state on the Journal page and
// one everywhere else: on Journal it starts open, as the Journal's day rail
// did, and stays closed there once closed. Elsewhere it starts closed, as on
// desktop, and so does the inspector, which only shows beside a note.

enum SideRailRoom: Equatable {
    case none, one, two

    /// `onJournal`: the Journal page, where one rail fits at any regular
    /// width (its day rail's shipped rule).
    init(width: CGFloat, regular: Bool, accessibilitySize: Bool, onJournal: Bool = false) {
        let one = Tokens.Size.reading + Tokens.Size.rail
        if !regular || accessibilitySize || (!onJournal && width < one) {
            self = .none
        } else {
            self = width >= one + Tokens.Size.rail ? .two : .one
        }
    }
}

/// Which rails are open, and what each toggle does to the other.
struct SideRailsOpen: Equatable {
    /// The Day Panel off the Journal page, where it shares the room with the
    /// inspector.
    var dayPanel: Bool
    /// The Day Panel on the Journal page.
    var journalDayPanel: Bool
    var inspector: Bool

    func dayPanelShown(in room: SideRailRoom, onJournal: Bool) -> Bool {
        (onJournal ? journalDayPanel : dayPanel) && room != .none
    }

    /// `panelRoom`: the Day Panel's room on the same page, `.none` where it
    /// cannot show.
    func inspectorShown(in room: SideRailRoom, panelRoom: SideRailRoom) -> Bool {
        inspector && (room == .two || (room == .one && !dayPanelShown(in: panelRoom, onJournal: false)))
    }

    mutating func toggleDayPanel(in room: SideRailRoom, onJournal: Bool) {
        if onJournal {
            journalDayPanel = !dayPanelShown(in: room, onJournal: true)
        } else if dayPanelShown(in: room, onJournal: false) {
            dayPanel = false
        } else {
            dayPanel = true
            if room != .two { inspector = false }
        }
    }

    mutating func toggleInspector(in room: SideRailRoom, panelRoom: SideRailRoom) {
        if inspectorShown(in: room, panelRoom: panelRoom) {
            inspector = false
        } else {
            inspector = true
            if room != .two { dayPanel = false }
        }
    }
}

/// The shell's rails: each page's room, the open states, and the day the Day
/// Panel shows where it follows no journal day. Every question names its
/// page; the shell asks for the selected one (`TasksRouter.selectedTab`).
@MainActor
@Observable
final class SideRails {
    static let dayPanelKey = "dayPanel.open"
    static let journalDayPanelKey = "dayPanel.journal.open"

    /// Each page's room, measured by its `DayPanelHost`.
    private var rooms: [VaultTab: SideRailRoom] = [:]
    /// The day stepped to where the panel follows no journal day; `nil`
    /// follows today.
    var steppedDay: String?
    private(set) var open: SideRailsOpen {
        didSet {
            defaults.set(open.dayPanel, forKey: Self.dayPanelKey)
            defaults.set(open.journalDayPanel, forKey: Self.journalDayPanelKey)
            defaults.set(open.inspector, forKey: NoteInspectorLayout.openKey)
        }
    }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let settings: LocalSettings

    init(defaults: UserDefaults = .standard, settings: LocalSettings = .shared) {
        self.defaults = defaults
        self.settings = settings
        open = SideRailsOpen(
            dayPanel: defaults.bool(forKey: Self.dayPanelKey),
            journalDayPanel: defaults.object(forKey: Self.journalDayPanelKey) as? Bool ?? true,
            inspector: defaults.bool(forKey: NoteInspectorLayout.openKey)
        )
    }

    func measured(_ room: SideRailRoom, on page: VaultTab) {
        if rooms[page] != room { rooms[page] = room }
    }

    /// The Day Panel's room on `page`: none on Calendar, which has its own
    /// agenda column, and none while Journal is off.
    func dayPanelRoom(on page: VaultTab) -> SideRailRoom {
        guard page != .calendar, settings.isOn(.journal) else { return .none }
        return rooms[page] ?? .none
    }

    func dayPanelFits(on page: VaultTab) -> Bool { dayPanelRoom(on: page) != .none }

    func dayPanelShown(on page: VaultTab) -> Bool {
        open.dayPanelShown(in: dayPanelRoom(on: page), onJournal: page == .journal)
    }

    func toggleDayPanel(on page: VaultTab) {
        open.toggleDayPanel(in: dayPanelRoom(on: page), onJournal: page == .journal)
    }

    // The inspector shows beside a note on the Notes page.
    var inspectorFits: Bool { rooms[.notes, default: .none] != .none }
    var inspectorShown: Bool {
        open.inspectorShown(in: rooms[.notes, default: .none], panelRoom: dayPanelRoom(on: .notes))
    }

    func toggleInspector() {
        open.toggleInspector(in: rooms[.notes, default: .none], panelRoom: dayPanelRoom(on: .notes))
    }

    /// The Day Panel's day: the journal's shown day where it follows one,
    /// else the day stepped to, else today.
    func dayPanelDate(following shownDay: String?, today: String) -> String {
        shownDay ?? steppedDay ?? today
    }

    /// The panel's own ‹ › and Today, and a day picked off the Journal page:
    /// the panel steps to it, and today goes back to following today.
    func step(to day: String, today: String) {
        steppedDay = day == today ? nil : day
    }
}

/// One page of the shell with the Day Panel beside it. Every page measures
/// its own room; only the selected page draws the panel. The Journal draws
/// it inside its stack (`JournalDayPanelBeside`), so its bar spans the panel.
struct DayPanelHost: ViewModifier {
    let page: VaultTab
    let isSelected: Bool

    @Environment(SideRails.self) private var rails
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.dynamicTypeSize) private var typeSize

    func body(content: Content) -> some View {
        let regular = LayoutWidth(horizontal: horizontalSizeClass, vertical: verticalSizeClass) == .regular
        let large = typeSize.isAccessibilitySize
        HStack(spacing: 0) {
            content
            if isSelected, page != .journal, rails.dayPanelShown(on: page) { DayPanel(page: page) }
        }
        .onGeometryChange(for: SideRailRoom.self) {
            SideRailRoom(width: $0.size.width, regular: regular, accessibilitySize: large, onJournal: page == .journal)
        } action: { rails.measured($0, on: page) }
    }
}

/// A Journal screen (Year, Month, Day) with the Day Panel beside it, inside
/// the Journal's stack: the screen's bar spans the panel, so the floating
/// tab bar of a portrait window leaves the day's own buttons room.
struct JournalDayPanelBeside: ViewModifier {
    @Environment(SideRails.self) private var rails: SideRails?
    @Environment(TasksRouter.self) private var tabs: TasksRouter?

    func body(content: Content) -> some View {
        HStack(spacing: 0) {
            content
            if tabs?.selectedTab == .journal, rails?.dayPanelShown(on: .journal) == true { DayPanel(page: .journal) }
        }
    }
}

/// The Day Panel for `page`: the day, or why the vault's journal is not open.
private struct DayPanel: View {
    let page: VaultTab

    @Environment(SideRails.self) private var rails
    @Environment(JournalRouter.self) private var journal
    @Environment(\.journalStore) private var store
    @Environment(\.journalStoreFailure) private var failure
    @Environment(\.journalTasks) private var tasks

    var body: some View {
        let hide = { rails.toggleDayPanel(on: page) }
        if let store {
            let today = store.clock.today
            let step = { (day: String) in rails.step(to: day, today: today) }
            DayPanelRail(
                store: store,
                date: rails.dayPanelDate(following: followedDay, today: today),
                // The Journal day's toolbar steps the day it shows.
                step: followedDay == nil ? step : nil,
                // On the Journal a picked day opens there, at every level.
                pick: page == .journal ? { day in
                    var transaction = Transaction()
                    transaction.disablesAnimations = true
                    withTransaction(transaction) { journal.showDay(day) }
                } : step,
                hide: hide
            )
            // The Tasks and Journal pages bind the prompts themselves.
            .modifier(JournalSubtaskPrompts(tasks: page == .tasks || page == .journal ? nil : tasks))
        } else {
            DayPanelUnavailable(failure: failure, hide: hide)
        }
    }

    /// On the journal page the panel follows the shown day.
    private var followedDay: String? { page == .journal ? journal.shownDay : nil }
}

/// The page's Day Panel button, while the panel is closed and fits. The open
/// panel carries its own hide button.
struct DayPanelToolbarItem: ToolbarContent {
    @Environment(SideRails.self) private var rails: SideRails?
    @Environment(TasksRouter.self) private var tabs: TasksRouter?

    var body: some ToolbarContent {
        if let rails, let page = tabs?.selectedTab, rails.dayPanelFits(on: page), !rails.dayPanelShown(on: page) {
            ToolbarItem(placement: .topBarTrailing) {
                Button(JournalCopy.Rail.show, systemImage: "calendar.day.timeline.trailing") {
                    rails.toggleDayPanel(on: page)
                }
                .accessibilityIdentifier("dayPanel.toggle")
            }
        }
    }
}
