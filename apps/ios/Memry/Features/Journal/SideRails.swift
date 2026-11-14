import Observation
import SwiftUI

// #4380. The side rails at regular width (`DESIGN.md` › Tablet › Side rails):
// the Day Panel beside every page, and the note inspector beside a note
// (#4347). One owner measures the page and says which rails fit, so the two
// never disagree about the room.
//
// **Room.** A rail shows only where the page keeps the `720pt` reading
// measure beside it (`1040pt`), and two rails need `1360pt`. Compact width
// and accessibility text sizes, which break words in the rail's `320pt`,
// hold none.
//
// **One at a time where two do not fit.** Opening one rail closes the other.
// When both are left open (a window that shrank), the Day Panel shows and the
// inspector waits; its button stays, and tapping it shows it and closes the
// panel.
//
// **Per device.** Both open states live in `UserDefaults`, never in the vault
// and never synced. Both start closed, as on desktop.

enum SideRailRoom: Equatable {
    case none, one, two

    init(width: CGFloat, regular: Bool, accessibilitySize: Bool) {
        let one = Tokens.Size.reading + Tokens.Size.rail
        if !regular || accessibilitySize || width < one {
            self = .none
        } else {
            self = width >= one + Tokens.Size.rail ? .two : .one
        }
    }
}

/// Which rails are open, and what each toggle does to the other.
struct SideRailsOpen: Equatable {
    var dayPanel: Bool
    var inspector: Bool

    func dayPanelShown(in room: SideRailRoom) -> Bool { dayPanel && room != .none }

    func inspectorShown(in room: SideRailRoom) -> Bool {
        inspector && (room == .two || (room == .one && !dayPanel))
    }

    mutating func toggleDayPanel(in room: SideRailRoom) {
        if dayPanelShown(in: room) {
            dayPanel = false
        } else {
            dayPanel = true
            if room != .two { inspector = false }
        }
    }

    mutating func toggleInspector(in room: SideRailRoom) {
        if inspectorShown(in: room) {
            inspector = false
        } else {
            inspector = true
            if room != .two { dayPanel = false }
        }
    }
}

/// The shell's rails: the room on the shown page, the open states, and the
/// day the Day Panel shows off the journal page.
@MainActor
@Observable
final class SideRails {
    static let dayPanelKey = "dayPanel.open"

    /// Measured by the shown page's `DayPanelHost`.
    var room: SideRailRoom = .none
    /// The day stepped to off the journal page; `nil` follows today.
    var steppedDay: String?
    private(set) var open: SideRailsOpen {
        didSet {
            defaults.set(open.dayPanel, forKey: Self.dayPanelKey)
            defaults.set(open.inspector, forKey: NoteInspectorLayout.openKey)
        }
    }

    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        open = SideRailsOpen(
            dayPanel: defaults.bool(forKey: Self.dayPanelKey),
            inspector: defaults.bool(forKey: NoteInspectorLayout.openKey)
        )
    }

    var dayPanelShown: Bool { open.dayPanelShown(in: room) }
    var inspectorFits: Bool { room != .none }
    var inspectorShown: Bool { open.inspectorShown(in: room) }

    func toggleDayPanel() { open.toggleDayPanel(in: room) }
    func toggleInspector() { open.toggleInspector(in: room) }

    /// The Day Panel's day: the journal's shown day where it follows one,
    /// else the day stepped to, else today.
    func dayPanelDate(following shownDay: String?, today: String) -> String {
        shownDay ?? steppedDay ?? today
    }

    /// A day picked in the panel. On the journal page it shows that day;
    /// elsewhere the panel steps to it, and today goes back to following
    /// today.
    func step(to day: String, today: String, journal: JournalRouter?) {
        if let journal, journal.shownDay != nil {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { journal.showDay(day) }
        } else {
            steppedDay = day == today ? nil : day
        }
    }
}

/// One page of the shell with the Day Panel beside it. It measures the page
/// for both rails and hands the room to the shell's `SideRails`.
struct DayPanelHost: ViewModifier {
    let page: VaultTab
    let isSelected: Bool

    @Environment(SideRails.self) private var rails
    @Environment(JournalRouter.self) private var journal
    @Environment(\.journalStore) private var store
    @Environment(\.journalTasks) private var tasks
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var room: SideRailRoom = .none

    func body(content: Content) -> some View {
        let regular = LayoutWidth(horizontal: horizontalSizeClass, vertical: verticalSizeClass) == .regular
        let large = typeSize.isAccessibilitySize
        HStack(spacing: 0) {
            content
            if rails.dayPanelShown, let store {
                let today = store.clock.today
                DayPanelRail(
                    store: store,
                    date: rails.dayPanelDate(following: followedDay, today: today),
                    show: { rails.step(to: $0, today: today, journal: followedDay == nil ? nil : journal) }
                )
                // The Tasks and Journal pages bind the prompts themselves.
                .modifier(JournalSubtaskPrompts(tasks: page == .tasks || page == .journal ? nil : tasks))
            }
        }
        .onGeometryChange(for: SideRailRoom.self) {
            SideRailRoom(width: $0.size.width, regular: regular, accessibilitySize: large)
        } action: { room = $0 }
        .onChange(of: isSelected ? room : nil, initial: true) { _, room in
            if let room { rails.room = room }
        }
    }

    /// On the journal page the panel follows the shown day.
    private var followedDay: String? { page == .journal ? journal.shownDay : nil }
}

/// The page's Day Panel button, where a rail fits.
struct DayPanelToolbarItem: ToolbarContent {
    @Environment(SideRails.self) private var rails: SideRails?

    var body: some ToolbarContent {
        if let rails, rails.room != .none {
            ToolbarItem(placement: .topBarTrailing) {
                Button(
                    rails.dayPanelShown ? JournalCopy.Rail.hide : JournalCopy.Rail.show,
                    systemImage: "calendar.day.timeline.trailing"
                ) { rails.toggleDayPanel() }
                    .accessibilityIdentifier("dayPanel.toggle")
            }
        }
    }
}
