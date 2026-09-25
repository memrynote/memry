import MemryCore
import SwiftUI

// JP040, JP041. The pushed Day page (J01-J03, J10) and moving between days.
//
// A paging `TabView` holds the shown day and its neighbours (desktop
// `PREFETCH_DAYS` = 1: building a neighbour's page reads it, which is the
// prefetch). A swipe, ‹ ›, the "Today" capsule or a hardware ← / → replace
// the shown day in place through `JournalRouter.showDay`, so Back still
// leads to the month; Esc drills up. Each page owns its own models keyed by
// its date, so an edit pending on one day never lands on another.

struct JournalDayScreen: View {
    let store: JournalStore
    let date: String

    @Environment(JournalRouter.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var selection: String
    @State private var pages = JournalDayPages()
    @State private var titleCollapsed = false

    /// Days kept either side of the shown one (desktop `PREFETCH_DAYS`).
    static let prefetchDays = 1

    init(store: JournalStore, date: String) {
        self.store = store
        self.date = date
        _selection = State(initialValue: date)
    }

    /// The shown day and its neighbours, oldest first.
    static func window(around date: String) -> [String] {
        (-prefetchDays...prefetchDays).map { JournalDates.adding($0, to: date) }
    }

    /// The date of a `j<YYYY-MM-DD>` record id (desktop `dateFromJournalId`).
    static func journalDate(ofId id: String) -> String? {
        guard id.hasPrefix("j") else { return nil }
        let date = String(id.dropFirst())
        return JournalDates.date(date) == nil ? nil : date
    }

    private var isToday: Bool { date == store.clock.today }

    var body: some View {
        TabView(selection: $selection) {
            ForEach(Self.window(around: date), id: \.self) { day in
                JournalDayPage(
                    store: store,
                    date: day,
                    model: pages.model(for: day),
                    isShown: day == selection,
                    open: open,
                    titleCollapsed: $titleCollapsed
                )
                .tag(day)
                .task { await pages.build(day, store: store) }
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .safeAreaInset(edge: .top) { JournalFailureBanner(store: store) }
        .background(Tokens.Canvas.background.color)
        .onChange(of: selection) { _, day in
            if day != date { show(day) }
        }
        .onChange(of: date) { _, day in
            selection = day
            titleCollapsed = false
            pages.keep(Self.window(around: day))
        }
        .navigationTitle(titleCollapsed ? JournalCopy.inlineTitle(date) : "")
        .navigationBarTitleDisplayMode(.inline)
        .journalTitleMenu(store: store, date: date)
        // Paper J01/J10: the day page's leading glass group is ‹ › (and
        // Today); Month and Year are one tap away in the title menu, and
        // Esc drills up (desktop keys), so the system Back is not drawn.
        .navigationBarBackButtonHidden(true)
        .toolbar { toolbar }
        .background { shortcuts }
        .accessibilityAction(named: JournalCopy.previousDay) { step(-1) }
        .accessibilityAction(named: JournalCopy.nextDay) { step(1) }
        .accessibilityAction(named: JournalCopy.goToToday) { show(store.clock.today) }
        .accessibilityIdentifier("journal.day")
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarLeading) {
            Button(JournalCopy.previousDay, systemImage: "chevron.backward") { step(-1) }
                .accessibilityIdentifier("journal.day.previous")
            Button(JournalCopy.nextDay, systemImage: "chevron.forward") { step(1) }
                .accessibilityIdentifier("journal.day.next")
        }
        if !isToday {
            ToolbarSpacer(.fixed, placement: .topBarLeading)
            ToolbarItem(placement: .topBarLeading) {
                Button(JournalCopy.today) { show(store.clock.today) }
                    .accessibilityLabel(JournalCopy.goToToday)
                    .accessibilityIdentifier("journal.day.today")
            }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            JournalBellButton(store: store, date: date)
            JournalMoreMenu(
                store: store,
                date: date,
                exportText: pages.model(for: date)?.read.exportText ?? "",
                find: { pages.model(for: date)?.finding = true }
            )
        }
    }

    /// Desktop's day keys (`pages/journal.tsx` keydown): ← / → change the
    /// day and Esc drills up. Hidden buttons carrying the shortcuts; a
    /// focused text field keeps its own arrow keys (system behaviour wins).
    private var shortcuts: some View {
        ZStack {
            Button(JournalCopy.previousDay) { step(-1) }
                .keyboardShortcut(.leftArrow, modifiers: [])
            Button(JournalCopy.nextDay) { step(1) }
                .keyboardShortcut(.rightArrow, modifiers: [])
            Button(JournalCopy.backToMonth) { router.drillUp() }
                .keyboardShortcut(.cancelAction)
        }
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// ‹ ›: page to the neighbour, which then becomes the shown day.
    private func step(_ days: Int) {
        let target = JournalDates.adding(days, to: date)
        withAnimation(Tokens.animation(.normal, .moving, reduceMotion: reduceMotion)) {
            selection = target
        }
    }

    /// Replaces the shown day in place. No push animation: the page already
    /// moved (or, for Today, jumps).
    private func show(_ day: String) {
        guard day != date else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { router.showDay(day) }
    }

    /// A backlink or wiki link: a journal id shows that day, a note pushes.
    private func open(_ route: NoteRoute) {
        if let day = Self.journalDate(ofId: route.id) {
            show(day)
        } else {
            router.path.append(.note(route.id))
        }
    }
}
