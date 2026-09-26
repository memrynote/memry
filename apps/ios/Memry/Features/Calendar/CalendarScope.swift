import Foundation
import MemryCore
import Observation
import SwiftUI

// Spec 007 CL022. Where the calendar lives: More › Calendar (goal D1), pushed
// on the More tab's stack so More stays selected, and the deep link
// `memry://calendar?date=YYYY-MM-DD&event=<projectionId|eventId>` that opens
// Day on the date with the item's sheet (desktop's Agent Chat focus).

/// The calendar's place on the More stack.
enum CalendarRoute: Hashable, Sendable {
    case calendar
    case settings
    case provider(String)
}

extension EnvironmentValues {
    /// The vault's calendar, when the keychain let one be built.
    @Entry var calendarStore: CalendarStore?
}

/// Builds the vault's calendar store when the vault opens, next to the tasks
/// store it reuses for task actions.
struct VaultCalendarScope<Content: View>: View {
    let vault: Vault
    let secureStore: (any SecureStore)?
    let filler: (any VaultFilling)?
    let tasks: TasksStore?
    @ViewBuilder let content: () -> Content
    @State private var store: CalendarStore?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        content()
            .environment(\.calendarStore, store)
            // The tasks store arrives a pass after the vault: rebuild once it does.
            .task(id: "\(vault.id())|\(tasks != nil)") { make() }
            // Another screen's sync pass (Tasks owns the vault's pass) also
            // brings calendar rows: re-read when it ends.
            .onChange(of: tasks?.isSyncing ?? false) { was, now in
                if was, !now, let store, store.hasLoaded { Task { await store.load() } }
            }
            // CL075: iOS may wake the app to sync while it is away.
            .onChange(of: scenePhase) { _, phase in
                if phase == .background, store != nil { CalendarBackgroundRefresh.shared.schedule() }
            }
    }

    private func make() {
        guard store?.vaultId != vault.id() || store?.tasks !== tasks else { return }
        store = nil
        guard let secureStore else { return }
        do {
            let calendar = try vault.calendar(store: secureStore)
            store = CalendarStore(core: calendar, vaultId: vault.id(), filler: filler, tasks: tasks)
            CalendarBackgroundRefresh.shared.store = store
        } catch {
            Log.core.error("the calendar could not be opened", .code(ErrorMapping.userFacing(error).code))
        }
    }
}

/// A parsed `memry://calendar` link.
struct CalendarLink: Equatable {
    let date: String?
    let event: String?

    init(date: String?, event: String?) {
        self.date = date
        self.event = event
    }

    init?(url: URL) {
        guard url.scheme == "memry", url.host() == "calendar" else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let date = items.first { $0.name == "date" }?.value
        // Only a `YYYY-MM-DD` day; anything else opens today.
        self.date = date.flatMap { $0.wholeMatch(of: /\d{4}-\d{2}-\d{2}/) != nil ? $0 : nil }
        event = items.first { $0.name == "event" }?.value.flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// Deep links that arrive before the vault shell exists wait here.
@MainActor
@Observable
final class CalendarLinks {
    static let shared = CalendarLinks()
    private(set) var pending: CalendarLink?

    func request(_ link: CalendarLink) { pending = link }

    func take() -> CalendarLink? {
        defer { pending = nil }
        return pending
    }
}

extension TasksRouter {
    /// More › Calendar, the tab selected (D1).
    func openCalendar() {
        selectedTab = .more
        var path = NavigationPath()
        path.append(CalendarRoute.calendar)
        settingsPath = path
    }
}
