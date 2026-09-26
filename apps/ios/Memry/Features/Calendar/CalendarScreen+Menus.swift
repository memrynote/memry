import MemryCore
import SwiftUI

// Spec 007 CL023/CL043 (artboards 02, 10, 11, 15). The title menu, the glass
// toolbar, the item menu and the routing of a tap by item type (flow lane E,
// desktop `handleSelectItem`).

extension CalendarScreen {
    // MARK: Title menu (02)

    @ViewBuilder
    var titleMenu: some View {
        Picker(CalendarCopy.title, selection: viewBinding) {
            ForEach(CalendarViewMode.allCases) { mode in
                Text(CalendarCopy.view(mode)).tag(mode)
            }
        }
        Section {
            Button {
                store.state.anchorDate = store.today
            } label: {
                // The second text is the menu row's subtitle (Paper 02 "Sep 24").
                Text(CalendarCopy.today)
                Text(CalendarDates.start(of: store.today).formatted(.dateTime.month(.abbreviated).day()))
            }
            .accessibilityIdentifier("calendar.menu.today")
            Button { sheet = .goToDate } label: {
                Label(CalendarCopy.goToDate, systemImage: "calendar")
            }
            .accessibilityIdentifier("calendar.menu.goto")
        }
        Section {
            Button {
                router.settingsPath.append(CalendarRoute.settings)
            } label: {
                Label(CalendarCopy.calendarSettings, systemImage: "gearshape")
            }
            .accessibilityIdentifier("calendar.menu.settings")
        }
    }

    private var viewBinding: Binding<CalendarViewMode> {
        Binding(get: { store.state.view }, set: { store.state.view = $0 })
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    var toolbarItems: some ToolbarContent {
        // Ink glyphs on the glass (00 rule 6: the tint fills, never carries).
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { sheet = .search } label: {
                Image(systemName: "magnifyingglass").foregroundStyle(Tokens.Text.primary.color)
            }
                .accessibilityLabel(CalendarCopy.searchOpen)
                .accessibilityIdentifier("calendar.search")
            if store.state.view == .timeline {
                CalendarTimelineDisplayMenu(settings: $store.state.timeline)
            } else {
                Button { sheet = .filter } label: {
                    Image(systemName: isFiltered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
                        .foregroundStyle(Tokens.Text.primary.color)
                }
                .accessibilityLabel(CalendarCopy.filterButton)
                .accessibilityIdentifier("calendar.filter")
            }
        }
    }

    private var isFiltered: Bool {
        !store.state.showMemryItems || !store.state.showImportedCalendars
            || store.state.importedSourceIds != nil
            || store.state.visualTypes.count != CalendarVisualType.allCases.count
    }

    // MARK: Grid actions

    var gridActions: CalendarGridActions {
        CalendarGridActions(
            open: { open($0) },
            complete: { item in Task { await store.completeTask(item) } },
            contextMenu: { item in AnyView(itemMenu(item)) },
            menu: { menuItem = $0 },
            select: { day, start, end in
                composer = CalendarComposerRequest(day: day, startMinute: start, endMinute: end, isAllDay: false)
            },
            selectDays: { first, last in
                composer = CalendarComposerRequest(day: first, startMinute: 0, endMinute: 0, isAllDay: true, lastDay: last)
            },
            move: { item, day, start, end in Task { await store.move(item, day: day, startMinute: start, endMinute: end) } },
            pending: composer.flatMap { request in
                request.isAllDay ? nil : CalendarGridSelection(day: request.day, startMinute: request.startMinute, endMinute: request.endMinute)
            }
        )
    }

    /// The long-press menu (15): Open for every item; memrynote events add
    /// Add to project and Delete; tasks add Complete.
    @ViewBuilder
    func itemMenu(_ item: CalendarItem) -> some View {
        Button { open(item) } label: { Label(CalendarCopy.open, systemImage: "arrow.up.forward.square") }
        if item.visualType == "task" {
            Button { Task { await store.completeTask(item) } } label: {
                Label(CalendarCopy.completeTask(item.title), systemImage: "checkmark.circle")
            }
        }
        if item.sourceType == "event" {
            Button { sheet = .project(item) } label: {
                Label(CalendarCopy.addToProject, systemImage: "folder")
            }
            Button(role: .destructive) { deleting = item } label: {
                Label(CalendarCopy.delete, systemImage: "trash")
            }
        }
    }

    // MARK: Opening (lane E)

    func open(_ item: CalendarItem) {
        if item.sourceType == "external_event", item.editability.canEditText {
            Task {
                if await store.promoteSkipsConfirm(item) {
                    if let id = await store.promote(item) { open(eventId: id) }
                } else {
                    promoting = item
                }
            }
            return
        }
        sheet = .item(item)
    }

    func open(eventId: String) {
        Task {
            await store.refreshAllWindows()
            let all = store.windows.values.flatMap { $0 }
            if let item = all.first(where: { $0.sourceType == "event" && $0.sourceId == eventId }) {
                sheet = .item(item)
            }
        }
    }

    func newEvent() {
        let day = store.state.view == .day ? store.anchor : store.today
        sheet = .editor(CalendarEditorRequest.new(day: day, startMinute: 9 * 60, endMinute: 10 * 60, allDay: false))
    }

    /// Search results and deep links: Day on the item's date, then its sheet.
    func openFocus(_ focus: CalendarFocus) {
        store.state.view = .day
        store.state.anchorDate = focus.date
        store.focus = nil
        guard focus.projectionId != nil || focus.sourceId != nil else { return }
        Task {
            await store.ensure(currentWindow)
            let all = store.windows.values.flatMap { $0 }
            let match = all.first { item in
                item.projectionId == focus.projectionId
                    || (focus.sourceId != nil && item.sourceId == focus.sourceId
                        && (focus.sourceType == nil || item.sourceType == focus.sourceType))
            }
            if let match { open(match) }
        }
    }

    func apply(_ link: CalendarLink) {
        let event = link.event
        let isProjection = event?.contains(":") == true
        store.focus = CalendarFocus(
            date: link.date ?? store.today,
            projectionId: isProjection ? event : nil,
            sourceType: isProjection ? nil : "event",
            sourceId: isProjection ? nil : event
        )
    }

    func delete(_ item: CalendarItem) async {
        let id = item.sourceId
        if await store.write({ try $0.deleteEvent(id: id) }) != nil {
            sheet = nil
        }
    }

    // MARK: Sheets

    @ViewBuilder
    func sheetContent(_ sheet: CalendarSheet) -> some View {
        switch sheet {
        case let .item(item):
            CalendarItemSheet(store: store, item: item, browse: browse, delete: { deleting = $0 }, addToProject: { self.sheet = .project($0) })
        case let .editor(request):
            CalendarEventEditor(store: store, request: request)
        case .filter:
            CalendarFilterSheet(store: store) {
                self.sheet = nil
                router.settingsPath.append(CalendarRoute.settings)
            }
        case .search:
            CalendarSearchSheet(store: store) { item in
                self.sheet = nil
                store.focus = CalendarFocus(date: CalendarDates.spanStart(item), projectionId: item.projectionId, sourceType: nil, sourceId: nil)
            }
        case .goToDate:
            CalendarGoToDateSheet(initial: store.anchor) { day in
                store.state.anchorDate = day
                self.sheet = nil
            }
        case let .yearPeek(day):
            CalendarDayPeekSheet(store: store, day: day, open: { item in
                self.sheet = nil
                store.focus = CalendarFocus(date: day, projectionId: item.projectionId, sourceType: nil, sourceId: nil)
            }, openDay: {
                self.sheet = nil
                store.state.view = .day
                store.state.anchorDate = day
            })
        case let .project(item):
            CalendarProjectPicker(store: store, eventId: item.sourceId, title: item.title)
        }
    }

    @ViewBuilder
    var composerInset: some View {
        if let request = composer {
            CalendarComposer(store: store, request: request, close: { composer = nil }, more: { draft in
                composer = nil
                sheet = .editor(draft)
            })
        }
    }
}
