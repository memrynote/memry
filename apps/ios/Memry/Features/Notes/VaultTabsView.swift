import MemryCore
import SwiftUI

// The shell an opened vault lives in: Home, Notes, two pages in the user's
// desktop rail order, and Menu for Settings and the pages that did not fit
// (`VaultTabLayout`). A tab that is not built yet says so.
//
// **Regular width is a sidebar** (`DESIGN.md` › Tablet, Q1/D1/D2): the same
// `TabView` with `.sidebarAdaptable`, every shown page its own row, Settings
// last in Menu's place, a Search row on top and the vault header above it.
// The Menu tab and its sheet exist only at compact width. Each tab keeps its
// value across a size-class change, and every page's stack lives on a router
// here (Notes keeps its own; its tab moves, and its id keeps that stack), so
// the selected page and its stack survive the switch. A portrait window
// starts on the tab bar instead (`VaultTabLayout.placement`). No
// `tabViewCustomization`: the order is desktop's synced rail, and the iPad
// writes no competing one.
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
    /// Home's switch. `nil` when the account holds one vault and there is
    /// nothing to switch to.
    let switchVault: (() -> Void)?
    /// The sidebar header's vault name and sync status (regular width).
    let vaultName: String
    let settings: SettingsContext?
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
    private let handoffLinks = HandoffLinks.shared
    @Environment(\.handoffVaultId) private var vaultId
    /// A continued activity from another vault (#4381).
    @State private var handoffMissing: HandoffItem.Kind?
    @Environment(\.inboxStore) private var inboxStore
    /// Features (settings spec ST44): a module turned off loses its tab.
    /// Home, Notes and Menu are always there.
    @State private var local = LocalSettings.shared
    /// Desktop's rail order, read from the synced settings.
    @State private var order = VaultTabOrder.shared
    @State private var showsMenu = false
    @State private var showsSearch = false
    /// Quick capture: Home's "+" and ⇧⌘N open the same sheet from here.
    @State private var capturing = false
    @State private var captureReceipt: CaptureReceipt?
    @Environment(\.quickCapture) private var capture
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.vaultBrowse) private var browse
    /// Reminder notification taps (TP053), handed over by the app delegate.
    private let reminderTaps = ReminderTaps.shared

    var body: some View {
        // Read here so the layout follows a module toggle and a synced order.
        let width = width
        let layout = VaultTabLayout(savedOrder: order.saved, width: width) { $0.isShown }
        GeometryReader { proxy in
            TabView(selection: Binding(
                get: { ShellTab.page(layout.barSelection(for: router.selectedTab)) },
                // Neither Menu nor Search becomes the selection by a tap: each
                // opens its sheet, which also catches a second tap on Menu.
                // Settings in the sidebar is a page like any other.
                set: { tab in
                    switch tab {
                    case .search: openSearch()
                    case .page(.more) where width == .compact: showsMenu = true
                    case let .page(page): router.selectedTab = page
                    }
                }
            )) {
                if width == .regular {
                    Tab(value: ShellTab.search, role: .search) { Color.clear }
                }
                ForEach(layout.bar, id: \.self) { page in
                    Tab(page.title, systemImage: page.symbol, value: ShellTab.page(page)) {
                        shown(page)
                    }
                    .badge(width == .regular && page == .inbox ? inboxStore?.badgeCount ?? 0 : 0)
                }
                Tab(
                    width == .regular ? SettingsCopy.title : VaultTab.more.title,
                    systemImage: width == .regular ? "gearshape" : VaultTab.more.symbol,
                    value: ShellTab.page(.more)
                ) {
                    shown(layout.menuContent(for: router.selectedTab))
                }
            }
            .tabViewStyle(.sidebarAdaptable)
            // Read before the first frame: a placement set after it does not
            // close a sidebar already shown.
            .defaultAdaptableTabBarPlacement(VaultTabLayout.placement(for: proxy.size))
            .tabViewSidebarHeader {
                VaultSidebarHeader(name: vaultName, context: settings, switchVault: switchVault)
            }
        }
        // The app's keyboard commands (`MemryCommands`), ⌘K among them.
        .focusedSceneValue(\.vaultCommands, commands(pages: layout.commandPages))
        .sheet(isPresented: $showsMenu) {
            VaultMenuSheet(pages: layout.menu) { page in
                router.selectedTab = page
                showsMenu = false
            }
            .presentationDetents([.medium])
        }
        // The Menu sheet is compact-only: a window resized to regular width
        // drops it rather than show it with the sidebar's empty menu. Search
        // closes too rather than swap its sheet for the palette mid-query.
        .onChange(of: width) {
            showsMenu = false
            showsSearch = false
        }
        // Settings is a split view in the sidebar's width (#4348).
        .onChange(of: width, initial: true) { _, width in router.setSettingsSplit(width == .regular) }
        .sheet(isPresented: $capturing) {
            if let capture {
                QuickCaptureSheet(
                    kinds: CaptureKind.allCases.filter(\.isShown),
                    capture: capture,
                    draft: capture.homeDraft
                ) { captureReceipt = $0 }
            }
        }
        .task(id: captureReceipt) {
            guard captureReceipt != nil else { return }
            try? await Task.sleep(for: .seconds(4))
            captureReceipt = nil
        }
        .sheet(isPresented: searchShown(.compact)) { searchView(.sheet) }
        // D3: a palette over the window at regular width (#4426).
        .fullScreenCover(isPresented: searchShown(.regular)) {
            searchView(.palette)
                .presentationBackground(.clear)
        }
        .environment(\.openGlobalSearch, openSearch)
        .environment(router)
        .environment(journalRouter)
        // Where the next launch continues (`LaunchSnapshot`).
        .onChange(of: router.selectedTab) { _, tab in LaunchSnapshot.shared.setTab(tab.rawValue) }
        .onChange(of: router.selectedTab, initial: true) { _, tab in tab.trackPageView() }
        .onChange(of: router.path) { _, path in LaunchSnapshot.shared.setStack("tasks", value: path) }
        .environment(\.openJournalDay, { date in journalRouter.openDay(date) })
        .environment(inboxRouter)
        // A `memry://calendar` link opens More › Calendar; the calendar screen
        // takes the link itself and opens the day and the item (spec 007 CL022).
        .onChange(of: calendarLinks.pending, initial: true) { _, pending in
            if pending != nil { router.openCalendar() }
        }
        // Handoff from another device; one that arrived before this shell
        // waits in `HandoffLinks`, hence `initial: true`.
        .onChange(of: handoffLinks.pending, initial: true) {
            guard let vaultId, let activity = handoffLinks.take() else { return }
            handoffMissing = activity.open(
                openVault: vaultId, tasks: router, journal: journalRouter, notes: .shared
            )
        }
        .sheet(item: $handoffMissing) { HandoffMissingView(kind: $0) }
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

    private var width: LayoutWidth {
        LayoutWidth(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
    }

    /// Opens search the way this width shows it. The palette appears in
    /// place, without the full-screen cover's slide.
    private func openSearch() {
        var transaction = Transaction()
        transaction.disablesAnimations = width == .regular
        withTransaction(transaction) { showsSearch = true }
    }

    /// Whether search is open at `shown` width.
    private func searchShown(_ shown: LayoutWidth) -> Binding<Bool> {
        Binding(get: { showsSearch && width == shown }, set: { showsSearch = $0 })
    }

    private func searchView(_ presentation: SearchPresentation) -> some View {
        GlobalSearchSheet(
            presentation: presentation,
            browse: browse,
            openNote: { openNote($0) },
            openTask: { router.openTask($0) },
            openInboxItem: { inboxRouter.openItem($0, in: router) },
            openJournalDay: { journalRouter.openDay($0) }
        )
        .environment(router)
    }

    /// A note on the Notes page, which takes the request itself.
    private func openNote(_ id: String) {
        router.selectedTab = .notes
        NotesLinks.shared.open(id)
    }

    private func commands(pages: [VaultTab]) -> VaultCommands {
        var newNote: (() -> Void)?
        if browse?.writer != nil { newNote = self.newNote }
        var quickCapture: (() -> Void)?
        if capture != nil { quickCapture = openCapture }
        return VaultCommands(
            tasks: router,
            journal: journalRouter,
            pages: pages,
            newNote: newNote,
            quickCapture: quickCapture,
            search: openSearch
        )
    }

    private func openCapture() { capturing = true }

    /// ⌘N: the Notes page makes the note, as its "+" does.
    private func newNote() {
        router.selectedTab = .notes
        NotesLinks.shared.requestNewNote()
    }

    /// A capture's "View": the item on its page.
    private func open(_ receipt: CaptureReceipt) {
        captureReceipt = nil
        switch receipt.kind {
        case .inbox: inboxRouter.openItem(receipt.id, in: router)
        case .task: router.openTask(receipt.id)
        case .note: openNote(receipt.id)
        case .journal: journalRouter.openDay(receipt.id)
        }
    }

    /// A page with ⇧⌘N's confirmation over it. Home shows its own beside
    /// its "+".
    private func shown(_ page: VaultTab) -> some View {
        content(page).overlay(alignment: .bottom) {
            if page != .home, let captureReceipt {
                CaptureToast(receipt: captureReceipt) { open(captureReceipt) }
                    .frame(maxWidth: Tokens.Size.form)
                    .padding(.horizontal, Tokens.Space.inset)
                    .padding(.bottom, Tokens.Space.medium)
            }
        }
    }

    /// One page's screen. A page is either in the bar or behind Menu, so each
    /// is built in one place at a time.
    @ViewBuilder private func content(_ page: VaultTab) -> some View {
        switch page {
        case .home: HomeTab(switchVault: switchVault, receipt: captureReceipt, capture: openCapture) { open($0) }
        case .notes: notes()
        case .inbox: InboxTab(store: inboxStore)
        case .tasks: tasks()
        case .journal: journal()
        case .calendar: more().environment(\.shellPage, .calendar)
        case .more: more().environment(\.shellPage, .more)
        }
    }
}

/// A tab's value: a page, or the sidebar's Search row, which opens search
/// instead of becoming the selection.
private enum ShellTab: Hashable {
    case page(VaultTab)
    case search
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
