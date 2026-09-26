import MemryCore
import SwiftUI

// Spec 007 CL023 (artboards 01, 02). The calendar screen: the large month
// title with its title menu (view picker, Today, Go to date…, Calendar
// settings), the glass capsule with Search and Filter (Display on Timeline),
// the view, the floating "+", the undo toast, and every sheet an item opens.

struct CalendarDestination: View {
    let route: CalendarRoute
    let store: CalendarStore?
    let browse: VaultBrowseViewModel?

    var body: some View {
        if let store {
            switch route {
            case .calendar: CalendarScreen(store: store, browse: browse)
            case .settings: CalendarSettingsScreen(store: store)
            case let .provider(provider): CalendarProviderScreen(store: store, provider: provider)
            }
        } else {
            ProgressView(CalendarCopy.loading)
        }
    }
}

/// Which sheet the screen shows.
enum CalendarSheet: Identifiable {
    case item(CalendarItem)
    case editor(CalendarEditorRequest)
    case filter
    case search
    case goToDate
    case yearPeek(String)
    case project(CalendarItem)

    var id: String {
        switch self {
        case let .item(item): "item.\(item.projectionId)"
        case let .editor(request): "editor.\(request.id)"
        case .filter: "filter"
        case .search: "search"
        case .goToDate: "goto"
        case let .yearPeek(day): "peek.\(day)"
        case let .project(item): "project.\(item.projectionId)"
        }
    }
}

struct CalendarScreen: View {
    @Bindable var store: CalendarStore
    let browse: VaultBrowseViewModel?
    @Environment(TasksRouter.self) var router
    @Environment(\.scenePhase) private var scenePhase
    @State var sheet: CalendarSheet?
    @State var composer: CalendarComposerRequest?
    @State var menuItem: CalendarItem?
    @State var deleting: CalendarItem?
    @State var promoting: CalendarItem?
    @State private var links = CalendarLinks.shared

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            content
                .safeAreaInset(edge: .top, spacing: 0) { header }
            if composer == nil {
                FloatingAddButton(
                    label: CalendarCopy.createEvent,
                    hint: CalendarCopy.createEventHint,
                    identifier: "calendar.add"
                ) { newEvent() }
                .padding(.trailing, Tokens.Space.inset + Tokens.Space.tight)
                .padding(.bottom, Tokens.Space.inset)
            }
        }
        .overlay(alignment: .bottom) { toast }
        .safeAreaInset(edge: .bottom, spacing: 0) { composerInset }
        .background(Tokens.Canvas.background.color)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarItems }
        .sheet(item: $sheet) { sheetContent($0) }
        .confirmationDialog(menuItem?.title ?? "", isPresented: menuBinding, titleVisibility: .visible) {
            if let item = menuItem { itemMenu(item) }
        }
        .alert(CalendarCopy.deleteTitle, isPresented: deleteBinding, presenting: deleting) { item in
            Button(CalendarCopy.deleteConfirm, role: .destructive) { Task { await delete(item) } }
            Button(CalendarCopy.cancel, role: .cancel) {}
        } message: { item in
            Text(CalendarCopy.deleteMessage(item))
        }
        .calendarPromoteAlert(store: store, item: $promoting) { eventId in open(eventId: eventId) }
        .task { await start() }
        .task(id: loadKey) { await store.ensure(currentWindow) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.load() } }
        }
        .onChange(of: links.pending, initial: true) {
            if let link = links.take() { apply(link) }
        }
        .onChange(of: store.focus) { _, focus in if let focus { openFocus(focus) } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.screen")
    }

    // MARK: Layout

    @ViewBuilder
    private var content: some View {
        switch store.state.view {
        case .day: CalendarDayView(store: store, actions: gridActions)
        case .week: CalendarWeekView(store: store, actions: gridActions)
        case .month: CalendarMonthView(store: store, actions: gridActions)
        case .year: CalendarYearView(store: store) { sheet = .yearPeek($0) }
        case .timeline: CalendarTimelineView(store: store, openItem: open)
        }
    }

    private var header: some View {
        TitleMenuHeader(
            title: CalendarPeriods.title(store.state.view, anchor: store.anchor),
            subtitle: store.state.view == .timeline
                ? CalendarTimelineView.summary(store)
                : CalendarPeriods.subtitle(store.state.view, anchor: store.anchor, weekStartsOn: store.weekStartsOn),
            menuHint: CalendarCopy.titleMenuHint,
            identifier: "calendar"
        ) { titleMenu }
        .padding(.horizontal, Tokens.Space.inset + Tokens.Space.tight)
        .padding(.top, Tokens.Space.tight)
        .padding(.bottom, Tokens.Space.small)
        .background(Tokens.Canvas.background.color)
    }

    var currentWindow: CalendarWindow {
        CalendarPeriods.window(store.state.view, anchor: store.anchor, weekStartsOn: store.weekStartsOn, zoom: store.state.timeline.zoom)
    }

    private var loadKey: String {
        "\(currentWindow.startAt)|\(currentWindow.endAt)|\(store.state.calendarProperties)|\(store.showNotesOnCalendar)"
    }

    @ViewBuilder
    private var toast: some View {
        if let toast = store.toast {
            UndoToastCard(
                message: toast.message,
                undoTitle: CalendarCopy.undo,
                undoHint: CalendarCopy.undoHint,
                identifier: "calendar.toast",
                undo: toast.undo.map { undo in { store.toast = nil; Task { await undo() } } }
            )
            .padding(.horizontal, Tokens.Space.inset)
            .padding(.trailing, Tokens.Size.minimumHitArea + Tokens.Space.inset)
            .padding(.bottom, Tokens.Space.inset)
            .task(id: toast.id) {
                try? await Task.sleep(for: .seconds(5))
                if store.toast?.id == toast.id { store.toast = nil }
            }
        }
    }

    // MARK: Lifecycle

    private func start() async {
        if !store.hasLoaded { await store.load() }
        await store.ensure(currentWindow)
    }

    private var menuBinding: Binding<Bool> {
        Binding(get: { menuItem != nil }, set: { if !$0 { menuItem = nil } })
    }

    private var deleteBinding: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }
}
