import MemryCore
import SwiftUI

// The shell an opened vault lives in: Home, Notes, two pages in the user's
// desktop rail order, and Menu for Settings and the pages that did not fit
// (`VaultTabLayout`). A tab that is not built yet says so.
//
// **Menu is a tab that opens a sheet.** Tapping it lists the pages behind it
// and Settings; the pick shows under the Menu tab. `router.selectedTab` stays
// the page itself, so every existing "open the Journal" route keeps working
// wherever that page sits.
//
// Inbox, Tasks, Journal and Calendar hide when turned off in Settings › Features (settings spec ST44).
//
// **A tab that is not built says what is true, and is not removed.** Kaan's
// call: ship the bar now. `DESIGN.md` forbids a dead control, not an honest
// limitation — "If a feature is intentionally unavailable on mobile, show a
// clear limitation instead of a dead control or a partial imitation" — so each
// unbuilt tab opens a screen that names the feature, says where it works
// today, and promises no date.
//
// **The bar is the platform's.** `TabView` with `Tab` gets the system's own
// bar, which on this OS is glass, adapts to the keyboard, collapses on scroll
// and carries the accessibility semantics. Nothing here asks for a material.
//
// **Only the Notes tab owns a stack.** `NotesListView` has its own
// `NavigationStack` and the two `navigationDestination` registrations research
// R15 requires; a second stack wrapped around it here would push its screens
// into the wrong one.

struct VaultTabsView<Notes: View, Tasks: View, Journal: View, More: View>: View {
    @ViewBuilder let notes: () -> Notes
    /// The Tasks tab (spec 004 TP031), built by the caller that holds the
    /// vault, keychain and sync.
    @ViewBuilder let tasks: () -> Tasks
    /// The Journal tab (spec 005-journal JP031), built the same way.
    @ViewBuilder let journal: () -> Journal
    /// More › Settings (settings spec F1), built by the caller with the
    /// vault's settings context.
    @ViewBuilder let more: () -> More
    /// Cross-tab navigation: search, note task blocks and reminder taps open a
    /// task through it.
    @State private var router = TasksRouter.restored()
    /// Opens a day in the Journal tab from any surface (D11).
    @State private var journalRouter = JournalRouter()
    /// The Inbox tab's stack (inbox spec D1).
    @State private var inboxRouter = InboxRouter()
    private let inboxLinks = InboxLinks.shared
    private let calendarLinks = CalendarLinks.shared
    @Environment(\.inboxStore) private var inboxStore
    /// Features (settings spec ST44): a module turned off loses its tab.
    /// Home, Notes and Menu are always there.
    @State private var local = LocalSettings.shared
    /// Desktop's rail order, read from the synced settings.
    @State private var order = VaultTabOrder.shared
    @State private var showsMenu = false
    @State private var showsSearch = false
    @Environment(\.vaultBrowse) private var browse
    /// Reminder notification taps (TP053), handed over by the app delegate.
    private let reminderTaps = ReminderTaps.shared

    var body: some View {
        // Read here so the layout follows a module toggle and a synced order.
        let layout = VaultTabLayout(savedOrder: order.saved) { $0.isShown }
        TabView(selection: Binding(
            get: { layout.barSelection(for: router.selectedTab) },
            // Menu never becomes the selection by a tap: it opens the sheet,
            // which also catches a second tap on an already selected Menu.
            set: { tab in
                if tab == .more { showsMenu = true } else { router.selectedTab = tab }
            }
        )) {
            ForEach(layout.bar, id: \.self) { page in
                Tab(page.title, systemImage: page.symbol, value: page) {
                    content(page)
                }
            }
            Tab(VaultTab.more.title, systemImage: VaultTab.more.symbol, value: VaultTab.more) {
                content(layout.menuContent(for: router.selectedTab))
            }
        }
        .sheet(isPresented: $showsMenu) {
            VaultMenuSheet(pages: layout.menu) { page in
                router.selectedTab = page
                showsMenu = false
            }
            .presentationDetents([.medium])
        }
        .sheet(isPresented: $showsSearch) {
            GlobalSearchSheet(
                browse: browse,
                openNote: { openNote($0) },
                openTask: { router.openTask($0) },
                openJournalDay: { journalRouter.openDay($0) }
            )
            .environment(router)
        }
        .environment(\.openGlobalSearch) { showsSearch = true }
        .environment(router)
        .environment(journalRouter)
        // Where the next launch continues (`LaunchSnapshot`).
        .onChange(of: router.selectedTab) { _, tab in LaunchSnapshot.shared.setTab(tab.rawValue) }
        .onChange(of: router.path) { _, path in LaunchSnapshot.shared.setStack("tasks", value: path) }
        .environment(\.openJournalDay, { date in journalRouter.openDay(date) })
        .environment(inboxRouter)
        // A `memry://calendar` link opens More › Calendar; the calendar screen
        // takes the link itself and opens the day and the item (spec 007 CL022).
        .onChange(of: calendarLinks.pending, initial: true) { _, pending in
            if pending != nil { router.openCalendar() }
        }
        // A tapped inbox notification or a Share hand-off opens the Inbox.
        .onChange(of: inboxLinks.pending, initial: true) {
            if inboxLinks.take() { inboxRouter.openInbox(in: router) }
        }
        // A tapped reminder opens its task or its journal day; a tap from a
        // cold start waits in `ReminderTaps` until this shell exists, hence
        // `initial: true`.
        .onChange(of: reminderTaps.pending, initial: true) {
            journalRouter.tabs = router
            reminderTaps.take()?.open(in: router, journal: journalRouter)
        }
        // The vault closed or the account signed out: no reminder text may
        // outlive it on the lock screen. The next vault refills its own window.
        .onDisappear {
            Task {
                await ReminderScheduler.shared.clearAll()
                await InboxNotifications.clearAll()
            }
        }
        // Turning a module off stops its reminders on this phone (flow lane 06).
        .onChange(of: local.isOn(.tasks)) { _, on in
            if !on { Task { await ReminderScheduler.shared.clearAll() } }
        }
        .onChange(of: local.isOn(.inbox)) { _, on in
            if !on { Task { await InboxNotifications.clearAll() } }
        }
        // Sign out lives on Settings › Account (F1), so the shell stops
        // drawing it over every screen of the vault.
        .preference(key: SignOutHostedKey.self, value: true)
    }

    /// A note on the Notes page, which takes the request itself.
    private func openNote(_ id: String) {
        router.selectedTab = .notes
        NotesLinks.shared.open(id)
    }

    /// A capture's "View": the item on its page.
    private func open(_ receipt: CaptureReceipt) {
        switch receipt.kind {
        case .inbox: inboxRouter.openItem(receipt.id, in: router)
        case .task: router.openTask(receipt.id)
        case .note: openNote(receipt.id)
        case .journal: journalRouter.openDay(receipt.id)
        }
    }

    /// One page's screen. A page is either in the bar or behind Menu, so each
    /// is built in one place at a time.
    @ViewBuilder private func content(_ page: VaultTab) -> some View {
        switch page {
        case .home: HomeTab { open($0) }
        case .notes: notes()
        case .inbox: InboxTab(store: inboxStore)
        case .tasks: tasks()
        case .journal: journal()
        case .calendar: more().environment(\.shellPage, .calendar)
        case .more: more().environment(\.shellPage, .more)
        }
    }
}

/// Menu's sheet: the pages that did not fit the bar, then Settings. A pick
/// shows under the Menu tab; the page behind the sheet does not change until
/// then.
private struct VaultMenuSheet: View {
    let pages: [VaultTab]
    let select: (VaultTab) -> Void

    var body: some View {
        NavigationStack {
            List {
                if !pages.isEmpty {
                    Section {
                        ForEach(pages, id: \.self) { page in
                            row(page, title: page.title, symbol: page.symbol)
                        }
                    }
                }
                Section {
                    row(.more, title: SettingsCopy.title, symbol: "gearshape")
                }
            }
            .navigationTitle(VaultTab.more.title)
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func row(_ page: VaultTab, title: String, symbol: String) -> some View {
        Button { select(page) } label: {
            Label(title, systemImage: symbol)
                .foregroundStyle(Tokens.Text.primary.color)
        }
        .accessibilityIdentifier(page == .more ? "menu.settings" : "menu.\(page.rawValue)")
    }
}

/// A tab that exists in the product and not yet on this phone.
///
/// It names the feature, says where it works today, and stops. No date, no
/// waitlist, no button: `DESIGN.md` rejects promising a mechanism the build
/// does not have.
private struct ComingSoonTab: View {
    let title: String
    let detail: String

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label(title, systemImage: "hourglass")
            } description: {
                Text(detail)
            }
            .navigationTitle(title)
            .background(Tokens.Canvas.background.color)
        }
    }
}
